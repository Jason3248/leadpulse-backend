'use strict';

const { Campaign, CampaignLead, LeadEngagement, Sequelize } = require('leadpulse-data-model');
const { NotFoundError, BusinessRuleError } = require('../../lib');
const assertClientOwnership = require('../client/assertClientOwnership.js');
const { campaignBilling } = require('../sequence/sequenceBilling.service.js');

const { Op } = Sequelize;

const rate = (numerator, denominator) =>
  denominator > 0 ? Number(((numerator / denominator) * 100).toFixed(2)) : 0;

class EmailAnalyticsService {
  /** Engagement funnel and rates, per SRS 4.8.2 / 4.8.5. */
  async campaignAnalytics(campaignId, managerId) {
    const campaign = await Campaign.findByPk(campaignId);
    if (!campaign) throw new NotFoundError('Campaign not found.');
    try {
      await assertClientOwnership(campaign.clientId, managerId, { requireActive: false });
    } catch (err) {
      if (err instanceof NotFoundError) throw new NotFoundError('Campaign not found.');
      throw err;
    }
    if (campaign.type !== 'email') {
      throw new BusinessRuleError('This is not an email campaign.');
    }

    const campaignLeadIds = (
      await CampaignLead.findAll({ where: { campaignId }, attributes: ['id'] })
    ).map((cl) => cl.id);

    if (campaignLeadIds.length === 0) {
      return { funnel: { audience: 0, sent: 0, delivered: 0, opened: 0, clicked: 0, converted: 0 }, rates: {} };
    }

    const where = { campaignLeadId: { [Op.in]: campaignLeadIds } };
    const count = (extra) => LeadEngagement.count({ where: { ...where, ...extra } });

    const [attempted, sent, delivered, opened, clicked, converted, unsubscribed, bounced] = await Promise.all([
      count({}),
      // "sent" must mean actually handed to the provider. sentAt is stamped
      // only on provider acceptance, so a rejected send never inflates the
      // figure the client sees, nor the denominator of every rate below.
      // (errorMessage can't be used for this — the webhook also writes
      // bounce reasons there, which are a different thing entirely.)
      count({ sentAt: { [Op.ne]: null } }),
      count({ deliveredAt: { [Op.ne]: null } }),
      count({ openedAt: { [Op.ne]: null } }),
      count({ clickedAt: { [Op.ne]: null } }),
      count({ convertedAt: { [Op.ne]: null } }),
      count({ unsubscribedAt: { [Op.ne]: null } }),
      count({ status: 'bounced' })
    ]);

    // Delivery events only arrive via the provider webhook. Without one
    // wired up, delivered stays 0 — so rates that divide by it would read
    // as 0% and look like a failure rather than "not measured yet". Fall
    // back to sent so the numbers stay meaningful either way.
    const deliveredBase = delivered > 0 ? delivered : sent;

    return {
      funnel: { audience: campaignLeadIds.length, attempted, sent, delivered, opened, clicked, converted },
      rates: {
        deliveryRate: rate(delivered, sent),
        openRate: rate(opened, deliveredBase),
        clickThroughRate: rate(clicked, deliveredBase),
        clickToOpenRate: rate(clicked, opened),
        bounceRate: rate(bounced, sent),
        unsubscribeRate: rate(unsubscribed, deliveredBase),
        conversionRate: rate(converted, deliveredBase)
      },
      // SRS 4.10 alert thresholds — surfaced as flags rather than emails,
      // so the manager sees them without needing a notification pipeline.
      alerts: {
        highBounceRate: rate(bounced, sent) > 10,
        highUnsubscribeRate: rate(unsubscribed, deliveredBase) > 5
      },
      billing: await campaignBilling(campaign)
    };
  }

  _billing(campaign, convertedCount) {
    if (campaign.pricingModel === 'cost_per_lead') {
      return {
        pricingModel: 'cost_per_lead',
        ratePerLead: Number(campaign.ratePerLead),
        // Email conversions need no human confirmation — the lead's own CTA
        // click is self-evident, unlike a self-reported call outcome.
        confirmedConversions: convertedCount,
        amountAccrued: Number((convertedCount * Number(campaign.ratePerLead)).toFixed(2))
      };
    }
    if (campaign.pricingModel === 'flat_retainer') {
      return {
        pricingModel: 'flat_retainer',
        retainerAmount: Number(campaign.retainerAmount),
        confirmedConversions: convertedCount,
        costPerConversion: convertedCount
          ? Number((Number(campaign.retainerAmount) / convertedCount).toFixed(2))
          : null
      };
    }
    return null;
  }
}

module.exports = new EmailAnalyticsService();
