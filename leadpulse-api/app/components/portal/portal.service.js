'use strict';

const {
  Campaign,
  CampaignLead,
  CallRemark,
  Client,
  LeadEngagement,
  LeadListMembership,
  Sequence,
  SequenceConversion,
  Sequelize,
  constants
} = require('leadpulse-data-model');
const { NotFoundError } = require('../../lib');
const { CLIENT_VISIBLE_STATUSES } = require('../report/reportData.service.js');
const { sequenceRollup } = require('../sequence/sequenceBilling.service.js');

const { Op } = Sequelize;
const { CAMPAIGN_TYPE, MEMBERSHIP_STATUS } = constants;

/**
 * The read-only Client Portal (SRS 4.11).
 *
 * Everything here is scoped to the requesting user's OWN clientId, taken
 * from their token — never from a request parameter — so a client can only
 * ever see their own data. Campaign detail and report downloads are served
 * by the existing report component (which already applies the same
 * Qualified/Converted redaction); the portal adds the two views reports
 * don't: an aggregate dashboard and a campaign list.
 *
 * The rule for what a client may see, reused from the report component so
 * the two can't drift: full aggregate COUNTS for the whole audience (proof
 * of effort and scale), but individual lead identities only once a lead
 * reaches Qualified or Converted. A client is buying qualified attention,
 * not the agency's raw sourced list.
 */
class PortalService {
  async _assertClient(user) {
    if (!user.clientId) throw new NotFoundError('No client portal is associated with this account.');
    const client = await Client.findByPk(user.clientId);
    // A deactivated client's portal users can still read historical data —
    // deactivation stops new work, it doesn't erase what was delivered.
    if (!client) throw new NotFoundError('Client not found.');
    return client;
  }

  /** Aggregate dashboard across every campaign run for this client. */
  async dashboard(user) {
    const client = await this._assertClient(user);

    const campaigns = await Campaign.findAll({
      where: { clientId: client.id },
      order: [['createdAt', 'DESC']]
    });

    const emailCampaigns = campaigns.filter((c) => c.type === CAMPAIGN_TYPE.EMAIL);
    const callCampaigns = campaigns.filter((c) => c.type === CAMPAIGN_TYPE.CALL);
    const campaignIds = campaigns.map((c) => c.id);

    // All figures are counts only — no individual identities — so they're
    // safe to show in full regardless of lead status.
    let totalLeadsTargeted = 0;
    let emailsSent = 0;
    let callsLogged = 0;
    let qualified = 0;
    let converted = 0;

    if (campaignIds.length) {
      const campaignLeads = await CampaignLead.findAll({
        where: { campaignId: { [Op.in]: campaignIds } },
        attributes: ['id', 'leadId', 'campaignId']
      });
      // UNIQUE people, not campaign_leads rows. A person touched by three
      // steps of one motion is one person reached, not three — counting rows
      // is what made this number exceed the size of the source list.
      totalLeadsTargeted = new Set(campaignLeads.map((cl) => cl.leadId)).size;
      const clIds = campaignLeads.map((cl) => cl.id);

      if (clIds.length) {
        emailsSent = await LeadEngagement.count({
          where: { campaignLeadId: { [Op.in]: clIds }, sentAt: { [Op.ne]: null } }
        });
        callsLogged = await CallRemark.count({ where: { campaignLeadId: { [Op.in]: clIds } } });
      }

      // Qualified/Converted counts come from membership status, the same
      // status that governs whether a client may see a lead's identity — so
      // "12 qualified" on the dashboard always matches how many leads the
      // client can actually open. Scoped to this client's own lists only.
      const clientListIds = [...new Set(campaigns.map((c) => c.leadListId))];
      const targetedLeadIds = [...new Set(campaignLeads.map((cl) => cl.leadId))];

      if (clientListIds.length && targetedLeadIds.length) {
        const memberships = await LeadListMembership.findAll({
          where: {
            leadListId: { [Op.in]: clientListIds },
            leadId: { [Op.in]: targetedLeadIds }
          }
        });

        // A lead may sit in more than one of this client's lists; keep the
        // furthest-along status so the count reflects its best outcome.
        const rank = { New: 0, Contacted: 1, Dead: 1, Qualified: 2, Converted: 3 };
        const statusByLead = new Map();
        memberships.forEach((m) => {
          const prev = statusByLead.get(m.leadId);
          if (!prev || rank[m.status] > rank[prev]) statusByLead.set(m.leadId, m.status);
        });
        statusByLead.forEach((status) => {
          if (status === MEMBERSHIP_STATUS.QUALIFIED) qualified += 1;
          if (status === MEMBERSHIP_STATUS.CONVERTED) converted += 1;
        });
      }
    }

    return {
      client: { id: client.id, name: client.name },
      totals: {
        campaigns: campaigns.length,
        emailCampaigns: emailCampaigns.length,
        callCampaigns: callCampaigns.length,
        leadsTargeted: totalLeadsTargeted,
        emailsSent,
        callsLogged,
        qualifiedLeads: qualified,
        convertedLeads: converted
      }
    };
  }

  /**
   * Sequences (outreach motions) run for this client — the commercial unit
   * they actually contracted for. Each carries deduplicated totals and
   * sequence-level billing, so a 3-step motion shows ONE amount owed rather
   * than three.
   */
  async sequences(user) {
    const client = await this._assertClient(user);

    const sequences = await Sequence.findAll({
      where: { clientId: client.id },
      order: [['createdAt', 'DESC']]
    });

    const rollups = await Promise.all(sequences.map((seq) => sequenceRollup(seq.id)));

    // Strip anything the client shouldn't see. Aggregate counts and billing
    // are fine (that's what they're paying for); no lead identities appear
    // anywhere in a rollup by construction.
    return rollups.filter(Boolean).map((r) => ({
      id: r.sequence.id,
      name: r.sequence.name,
      description: r.sequence.description,
      createdAt: r.sequence.createdAt,
      steps: r.steps.map((st) => ({ name: st.name, type: st.type, status: st.status, stepOrder: st.stepOrder })),
      totals: r.totals,
      conversionsByStep: r.conversionsByStep,
      billing: r.billing
    }));
  }

  /** One sequence in full, for a client drilling into a motion. */
  async sequenceDetail(user, sequenceId) {
    const client = await this._assertClient(user);

    const sequence = await Sequence.findOne({ where: { id: sequenceId, clientId: client.id } });
    // Scoped to their own clientId — another client's sequence is simply
    // not found, never a 403 that would confirm it exists.
    if (!sequence) throw new NotFoundError('Sequence not found.');

    const rollup = await sequenceRollup(sequence.id);
    return {
      id: rollup.sequence.id,
      name: rollup.sequence.name,
      description: rollup.sequence.description,
      createdAt: rollup.sequence.createdAt,
      steps: rollup.steps.map((st) => ({ name: st.name, type: st.type, status: st.status, stepOrder: st.stepOrder })),
      totals: rollup.totals,
      conversionsByStep: rollup.conversionsByStep,
      billing: rollup.billing
    };
  }

  /** Campaign history for this client — list view, no lead identities. */
  async campaigns(user) {
    const client = await this._assertClient(user);

    const campaigns = await Campaign.findAll({
      where: { clientId: client.id },
      order: [['createdAt', 'DESC']]
    });

    return Promise.all(
      campaigns.map(async (c) => {
        const audienceCount = await CampaignLead.count({ where: { campaignId: c.id } });
        return {
          id: c.id,
          name: c.name,
          type: c.type,
          status: c.status,
          audienceCount,
          createdAt: c.createdAt,
          approvedAt: c.approvedAt,
          // Tells the client whether this campaign stands alone or is one
          // step of a larger motion — without it, a 3-step cadence looked
          // like three unrelated campaigns in their history.
          sequenceId: c.sequenceId,
          sequenceStepOrder: c.sequenceStepOrder,
          isStandalone: !c.sequenceId
        };
      })
    );
  }
}

module.exports = new PortalService();
module.exports.CLIENT_VISIBLE_STATUSES = CLIENT_VISIBLE_STATUSES;
