'use strict';

const {
  Campaign,
  CampaignLead,
  ClientLead,
  LeadEngagement,
  constants
} = require('leadpulse-data-model');
const { updateLeadStatus } = require('../lead/leadStatus.service.js');
const { recordConversion } = require('../sequence/sequenceBilling.service.js');
const logger = require('../../configs/logger.js');

const { MEMBERSHIP_STATUS, ENGAGEMENT_STATUS, BOUNCE_TYPE } = constants;

// 1x1 transparent GIF, returned for every open-pixel request.
const TRACKING_PIXEL = Buffer.from(
  'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7',
  'base64'
);

/**
 * All tracking endpoints are PUBLIC — they're hit by email clients and by
 * the recipient's browser, which carry no session. The unguessable 24-byte
 * token is the only credential, and it only ever identifies one engagement
 * row. Every handler here must therefore fail silently and harmlessly on a
 * bad token: an invalid open pixel still returns a valid image, an invalid
 * click still redirects somewhere sane. Leaking "that token doesn't exist"
 * would turn these into an enumeration oracle.
 */
class TrackingService {
  async _resolve(token) {
    if (!token) return null;
    const engagement = await LeadEngagement.findOne({
      where: { trackingToken: token },
      include: [{ model: CampaignLead, as: 'campaignLead' }]
    });
    if (!engagement) return null;
    const campaign = await Campaign.findByPk(engagement.campaignLead.campaignId);
    if (!campaign) return null;
    return { engagement, campaignLead: engagement.campaignLead, campaign };
  }

  /** Open pixel. Counts every open; first one also stamps openedAt. */
  async recordOpen(token) {
    const ctx = await this._resolve(token);
    if (!ctx) return TRACKING_PIXEL;

    const { engagement } = ctx;
    await engagement.update({
      openedAt: engagement.openedAt || new Date(),
      openCount: engagement.openCount + 1
    });
    return TRACKING_PIXEL;
  }

  /**
   * Click redirect. A click is a genuine interest signal, so it promotes
   * the lead to Qualified — the MQL-equivalent threshold we settled on
   * (an open alone is too weak a signal to promote on).
   */
  async recordClick(token, targetUrl) {
    const ctx = await this._resolve(token);
    if (!ctx) return null;

    const { engagement, campaignLead, campaign } = ctx;
    await engagement.update({
      clickedAt: engagement.clickedAt || new Date(),
      clickCount: engagement.clickCount + 1
    });

    await updateLeadStatus({
      leadListId: campaign.leadListId,
      leadId: campaignLead.leadId,
      newStatus: MEMBERSHIP_STATUS.QUALIFIED,
      isManualOverride: false
    });

    return targetUrl;
  }

  /**
   * The dedicated "I'm interested" CTA — distinct from an ordinary content
   * click. This is the only automatic path to Converted for email, and it
   * needs no human confirmation: unlike a self-reported call outcome, the
   * lead's own click can't be fabricated by anyone at the agency.
   */
  async recordConversion(token) {
    const ctx = await this._resolve(token);
    if (!ctx) return null;

    const { engagement, campaignLead, campaign } = ctx;
    await engagement.update({
      convertedAt: engagement.convertedAt || new Date(),
      clickedAt: engagement.clickedAt || new Date(),
      clickCount: engagement.clickCount + 1
    });

    await updateLeadStatus({
      leadListId: campaign.leadListId,
      leadId: campaignLead.leadId,
      newStatus: MEMBERSHIP_STATUS.CONVERTED,
      isManualOverride: false
    });

    // Ledger for billing. A lead who converted at an earlier step and clicks
    // the CTA again on a later "thank you" email is NOT billed twice — the
    // unique (sequence, lead) constraint makes that structurally impossible.
    await recordConversion({ campaign, leadId: campaignLead.leadId, channel: 'email' });

    return { campaignName: campaign.name };
  }

  /**
   * Unsubscribe. Sets the flag on the CLIENT relationship, not globally and
   * not per-list: opting out of this client's outreach must silence every
   * campaign that client runs, while never affecting a different client's
   * contact with the same person.
   */
  async recordUnsubscribe(token) {
    const ctx = await this._resolve(token);
    if (!ctx) return null;

    const { engagement, campaignLead, campaign } = ctx;
    await engagement.update({ unsubscribedAt: engagement.unsubscribedAt || new Date() });

    await ClientLead.update(
      { isUnsubscribed: true },
      { where: { clientId: campaign.clientId, leadId: campaignLead.leadId } }
    );

    logger.info('Lead unsubscribed', { clientId: campaign.clientId, leadId: campaignLead.leadId });
    return { campaignName: campaign.name };
  }

  /**
   * SendGrid event webhook. Maps provider event types onto our engagement
   * records. The important business rule here: a HARD bounce permanently
   * suppresses that address for this client, immediately and per-lead —
   * it does not wait for any campaign-wide bounce-rate threshold, because
   * a dead address is dead regardless of how the rest of the campaign did.
   */
  async handleWebhookEvents(events) {
    if (!Array.isArray(events)) return { processed: 0 };
    let processed = 0;

    for (const event of events) {
      const token = event.token || (event.unique_args && event.unique_args.token);
      const ctx = await this._resolve(token);
      if (!ctx) continue;

      const { engagement, campaignLead, campaign } = ctx;

      switch (event.event) {
        case 'delivered':
          await engagement.update({
            status: ENGAGEMENT_STATUS.DELIVERED,
            deliveredAt: new Date((event.timestamp || Date.now() / 1000) * 1000)
          });
          break;

        case 'bounce':
        case 'dropped': {
          // SendGrid signals permanence via type: 'bounce' (hard) vs
          // 'blocked' (soft/transient). Anything not explicitly transient
          // is treated as hard — erring toward suppression is the safer
          // default for deliverability.
          const isHard = event.type !== 'blocked';
          await engagement.update({
            status: ENGAGEMENT_STATUS.BOUNCED,
            bounceType: isHard ? BOUNCE_TYPE.HARD : BOUNCE_TYPE.SOFT,
            errorMessage: event.reason || null
          });

          if (isHard) {
            await ClientLead.update(
              { isHardBounced: true },
              { where: { clientId: campaign.clientId, leadId: campaignLead.leadId } }
            );
            logger.info('Hard bounce — address suppressed for this client', {
              clientId: campaign.clientId,
              leadId: campaignLead.leadId
            });
          }
          break;
        }

        case 'spamreport':
          // A spam complaint is a stronger signal than an unsubscribe:
          // suppress the address as well as recording the event.
          await engagement.update({ status: ENGAGEMENT_STATUS.SPAMREPORT });
          await ClientLead.update(
            { isUnsubscribed: true },
            { where: { clientId: campaign.clientId, leadId: campaignLead.leadId } }
          );
          break;

        case 'open':
          await engagement.update({
            openedAt: engagement.openedAt || new Date(),
            openCount: engagement.openCount + 1
          });
          break;

        case 'click':
          await engagement.update({
            clickedAt: engagement.clickedAt || new Date(),
            clickCount: engagement.clickCount + 1
          });
          await updateLeadStatus({
            leadListId: campaign.leadListId,
            leadId: campaignLead.leadId,
            newStatus: MEMBERSHIP_STATUS.QUALIFIED,
            isManualOverride: false
          });
          break;

        default:
          continue;
      }
      processed += 1;
    }

    return { processed };
  }
}

module.exports = { trackingService: new TrackingService(), TRACKING_PIXEL };
