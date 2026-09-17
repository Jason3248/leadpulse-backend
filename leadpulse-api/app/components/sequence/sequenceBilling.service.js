'use strict';

const {
  Campaign,
  CampaignLead,
  CallRemark,
  LeadEngagement,
  Sequence,
  SequenceConversion,
  Sequelize
} = require('leadpulse-data-model');
const logger = require('../../configs/logger.js');

const { Op } = Sequelize;

/**
 * Billing, and the "converted once per lead per sequence" rule.
 *
 * A client contracts for an outreach MOTION, not for individual sends. If a
 * cadence is Email -> Call -> Follow-up email, and one person converts at
 * step 2, the client is billed for that person ONCE — regardless of how many
 * steps touched them, or whether a later step (a thank-you email, say)
 * produces a second conversion event.
 *
 * That guarantee is structural, not a query convention: every conversion
 * attempts an insert into sequence_conversions, which has a unique
 * (sequence_id, lead_id) constraint. A second conversion for the same lead
 * in the same sequence is simply rejected, so billing can safely be "count
 * the rows" and can never double-count.
 *
 * Standalone campaigns (no sequenceId) are unaffected — they bill from their
 * own pricing columns exactly as before.
 */

/**
 * Record that a lead converted. Safe to call on every conversion event; the
 * second call for the same (sequence, lead) is a no-op.
 *
 * Returns true if this was the lead's FIRST conversion in the sequence
 * (i.e. newly billable), false if it was a duplicate or the campaign is
 * standalone.
 */
async function recordConversion({ campaign, leadId, channel, transaction }) {
  if (!campaign.sequenceId) return false; // standalone — nothing to dedupe against

  try {
    await SequenceConversion.create(
      {
        sequenceId: campaign.sequenceId,
        leadId,
        campaignId: campaign.id,
        channel,
        convertedAt: new Date()
      },
      { transaction }
    );
    return true;
  } catch (err) {
    // The unique constraint firing is the EXPECTED path when a lead converts
    // again later in the same sequence — it means "already billed", not an
    // error worth surfacing.
    if (err.name === 'SequelizeUniqueConstraintError') {
      logger.info('Lead already converted in this sequence — not billed again', {
        sequenceId: campaign.sequenceId,
        leadId
      });
      return false;
    }
    throw err;
  }
}

const money = (n) => Number(Number(n).toFixed(2));

function computeBilling({ pricingModel, ratePerLead, retainerAmount, billableConversions }) {
  if (pricingModel === 'cost_per_lead') {
    return {
      pricingModel: 'cost_per_lead',
      ratePerLead: money(ratePerLead),
      billableConversions,
      amountAccrued: money(billableConversions * Number(ratePerLead))
    };
  }
  if (pricingModel === 'flat_retainer') {
    return {
      pricingModel: 'flat_retainer',
      retainerAmount: money(retainerAmount),
      billableConversions,
      // The useful number under a retainer isn't "what's owed" (that's fixed)
      // but "what did each conversion effectively cost".
      costPerConversion: billableConversions ? money(Number(retainerAmount) / billableConversions) : null
    };
  }
  return null;
}

/** Billing for a whole sequence — the client-facing commercial unit. */
async function sequenceBilling(sequenceId) {
  const sequence = await Sequence.findByPk(sequenceId);
  if (!sequence) return null;

  const billableConversions = await SequenceConversion.count({ where: { sequenceId } });

  return computeBilling({
    pricingModel: sequence.pricingModel,
    ratePerLead: sequence.ratePerLead,
    retainerAmount: sequence.retainerAmount,
    billableConversions
  });
}

/**
 * Billing for one campaign. If it belongs to a sequence, billing is a
 * sequence-level concept and this returns a pointer to that rather than a
 * number — otherwise two steps of one motion would each appear to owe money.
 */
async function campaignBilling(campaign) {
  if (campaign.sequenceId) {
    const sequence = await Sequence.findByPk(campaign.sequenceId);
    return {
      billedAtSequenceLevel: true,
      sequenceId: campaign.sequenceId,
      sequenceName: sequence ? sequence.name : null,
      note: 'This campaign is one step of a sequence; billing is calculated across the whole sequence.'
    };
  }

  // Standalone: count unique converted leads within this campaign alone.
  const campaignLeads = await CampaignLead.findAll({ where: { campaignId: campaign.id }, attributes: ['id', 'leadId'] });
  if (campaignLeads.length === 0) {
    return computeBilling({
      pricingModel: campaign.pricingModel,
      ratePerLead: campaign.ratePerLead,
      retainerAmount: campaign.retainerAmount,
      billableConversions: 0
    });
  }

  const clIds = campaignLeads.map((cl) => cl.id);
  const leadIdByCampaignLeadId = new Map(campaignLeads.map((cl) => [cl.id, cl.leadId]));
  const convertedLeadIds = new Set();

  // Call side: only CONFIRMED conversions are billable — an unreviewed claim
  // must never reach a client-facing figure.
  const confirmed = await CallRemark.findAll({
    where: { campaignLeadId: { [Op.in]: clIds }, conversionConfirmed: true },
    attributes: ['campaignLeadId']
  });
  confirmed.forEach((r) => convertedLeadIds.add(leadIdByCampaignLeadId.get(r.campaignLeadId)));

  // Email side: the lead's own CTA click needs no human confirmation.
  const emailConverted = await LeadEngagement.findAll({
    where: { campaignLeadId: { [Op.in]: clIds }, convertedAt: { [Op.ne]: null } },
    attributes: ['campaignLeadId']
  });
  emailConverted.forEach((e) => convertedLeadIds.add(leadIdByCampaignLeadId.get(e.campaignLeadId)));

  return computeBilling({
    pricingModel: campaign.pricingModel,
    ratePerLead: campaign.ratePerLead,
    retainerAmount: campaign.retainerAmount,
    billableConversions: convertedLeadIds.size
  });
}

/**
 * Aggregate rollup for a sequence: deduplicated across every step.
 *
 * "Leads reached" counts UNIQUE people, not campaign_leads rows — a person
 * touched by three steps is one person reached, not three. Getting this
 * wrong is what made the old campaign-level dashboard report more leads
 * targeted than existed in the list.
 */
async function sequenceRollup(sequenceId) {
  const sequence = await Sequence.findByPk(sequenceId);
  if (!sequence) return null;

  const campaigns = await Campaign.findAll({
    where: { sequenceId },
    order: [
      ['sequenceStepOrder', 'ASC'],
      ['createdAt', 'ASC']
    ]
  });
  const campaignIds = campaigns.map((c) => c.id);

  let uniqueLeadsReached = 0;
  let emailsSent = 0;
  let callsLogged = 0;

  if (campaignIds.length) {
    const campaignLeads = await CampaignLead.findAll({
      where: { campaignId: { [Op.in]: campaignIds } },
      attributes: ['id', 'leadId']
    });
    uniqueLeadsReached = new Set(campaignLeads.map((cl) => cl.leadId)).size;

    const clIds = campaignLeads.map((cl) => cl.id);
    if (clIds.length) {
      emailsSent = await LeadEngagement.count({
        where: { campaignLeadId: { [Op.in]: clIds }, sentAt: { [Op.ne]: null } }
      });
      callsLogged = await CallRemark.count({ where: { campaignLeadId: { [Op.in]: clIds } } });
    }
  }

  const conversions = await SequenceConversion.findAll({ where: { sequenceId } });

  return {
    sequence: {
      id: sequence.id,
      name: sequence.name,
      description: sequence.description,
      clientId: sequence.clientId,
      leadListId: sequence.leadListId,
      createdAt: sequence.createdAt
    },
    steps: campaigns.map((c) => ({
      id: c.id,
      name: c.name,
      type: c.type,
      status: c.status,
      stepOrder: c.sequenceStepOrder
    })),
    totals: {
      steps: campaigns.length,
      uniqueLeadsReached,
      emailsSent,
      callsLogged,
      convertedLeads: conversions.length
    },
    // Which step each conversion happened at — useful for seeing whether the
    // motion converts early or needs the later touches.
    conversionsByStep: campaigns.map((c) => ({
      stepOrder: c.sequenceStepOrder,
      campaignName: c.name,
      conversions: conversions.filter((cv) => cv.campaignId === c.id).length
    })),
    billing: computeBilling({
      pricingModel: sequence.pricingModel,
      ratePerLead: sequence.ratePerLead,
      retainerAmount: sequence.retainerAmount,
      billableConversions: conversions.length
    })
  };
}

module.exports = { recordConversion, sequenceBilling, campaignBilling, sequenceRollup, computeBilling };
