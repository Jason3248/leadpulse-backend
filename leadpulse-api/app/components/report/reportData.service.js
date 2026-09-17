'use strict';

const {
  Campaign,
  CampaignLead,
  CampaignExecutive,
  CallRemark,
  Client,
  Lead,
  LeadEngagement,
  LeadListMembership,
  User,
  Sequelize,
  constants
} = require('leadpulse-data-model');
const { NotFoundError } = require('../../lib');

const { Op } = Sequelize;
const { CAMPAIGN_TYPE, MEMBERSHIP_STATUS, CALL_OUTCOME, ROLES } = constants;

// Statuses at which a lead's contact details become visible to the client.
// Below this, the client sees the lead only as a number in the aggregate
// counts. The agency's sourced list is its own asset — the client is buying
// qualified attention, not the raw contact database.
const CLIENT_VISIBLE_STATUSES = [MEMBERSHIP_STATUS.QUALIFIED, MEMBERSHIP_STATUS.CONVERTED];

const rate = (num, den) => (den > 0 ? Number(((num / den) * 100).toFixed(2)) : 0);

/**
 * Single source of truth for campaign reporting data.
 *
 * Everything that reports on a campaign — the PDF, the Excel export, the
 * manager's analytics view and the client portal — reads through here, so
 * the same campaign can never show different numbers in different places.
 *
 * `viewerRole` drives redaction rather than each caller remembering to
 * apply it: a client viewing their own campaign gets full aggregate counts
 * but contact details only for Qualified/Converted leads.
 */
class ReportDataService {
  async assertAccess(campaignId, user) {
    const campaign = await Campaign.findByPk(campaignId, {
      include: [{ model: Client, as: 'client' }]
    });
    if (!campaign) throw new NotFoundError('Campaign not found.');

    if (user.role === ROLES.CAMPAIGN_MANAGER) {
      if (campaign.client.managerId !== user.id) throw new NotFoundError('Campaign not found.');
      return campaign;
    }
    if (user.role === ROLES.CLIENT) {
      // A client may only ever see campaigns run for their own account.
      if (campaign.clientId !== user.clientId) throw new NotFoundError('Campaign not found.');
      return campaign;
    }
    if (user.role === ROLES.EXECUTIVE) {
      const assigned = await CampaignExecutive.findOne({
        where: { campaignId, executiveUserId: user.id, isActive: true }
      });
      if (!assigned) throw new NotFoundError('Campaign not found.');
      return campaign;
    }
    throw new NotFoundError('Campaign not found.');
  }

  /** Campaign header details — shared by every report format. */
  async summary(campaign) {
    const audience = await CampaignLead.count({ where: { campaignId: campaign.id } });
    return {
      id: campaign.id,
      name: campaign.name,
      type: campaign.type,
      status: campaign.status,
      clientName: campaign.client ? campaign.client.name : '',
      description: campaign.description,
      audience,
      createdAt: campaign.createdAt,
      approvedAt: campaign.approvedAt,
      generatedAt: new Date()
    };
  }

  /** Email engagement funnel and the SRS 4.8.5 rate formulas. */
  async emailMetrics(campaign) {
    const campaignLeadIds = (
      await CampaignLead.findAll({ where: { campaignId: campaign.id }, attributes: ['id'] })
    ).map((cl) => cl.id);

    if (campaignLeadIds.length === 0) {
      return { audience: 0, attempted: 0, sent: 0, delivered: 0, opened: 0, clicked: 0, converted: 0, rates: {} };
    }

    const where = { campaignLeadId: { [Op.in]: campaignLeadIds } };
    const count = (extra) => LeadEngagement.count({ where: { ...where, ...extra } });

    const [attempted, sent, delivered, opened, clicked, converted, unsubscribed, bounced] = await Promise.all([
      count({}),
      count({ sentAt: { [Op.ne]: null } }),
      count({ deliveredAt: { [Op.ne]: null } }),
      count({ openedAt: { [Op.ne]: null } }),
      count({ clickedAt: { [Op.ne]: null } }),
      count({ convertedAt: { [Op.ne]: null } }),
      count({ unsubscribedAt: { [Op.ne]: null } }),
      count({ status: 'bounced' })
    ]);

    // Delivery events only exist if a provider webhook is wired up. Without
    // one, delivered stays 0 and every rate built on it would read as 0% —
    // which looks like failure rather than "not measured". Fall back to sent.
    const base = delivered > 0 ? delivered : sent;

    return {
      audience: campaignLeadIds.length,
      attempted,
      sent,
      delivered,
      opened,
      clicked,
      converted,
      unsubscribed,
      bounced,
      rates: {
        deliveryRate: rate(delivered, sent),
        openRate: rate(opened, base),
        clickThroughRate: rate(clicked, base),
        clickToOpenRate: rate(clicked, opened),
        bounceRate: rate(bounced, sent),
        unsubscribeRate: rate(unsubscribed, base),
        conversionRate: rate(converted, base)
      }
    };
  }

  /** Call outcome distribution, funnel and per-executive performance. */
  async callMetrics(campaign) {
    const campaignLeads = await CampaignLead.findAll({ where: { campaignId: campaign.id } });
    const clIds = campaignLeads.map((cl) => cl.id);

    const queue = { total: campaignLeads.length, pending: 0, in_progress: 0, called: 0, completed: 0, skipped: 0 };
    campaignLeads.forEach((cl) => {
      if (queue[cl.queueStatus] !== undefined) queue[cl.queueStatus] += 1;
    });

    if (clIds.length === 0) {
      return { queue, outcomes: {}, funnel: { total: 0, reached: 0, interested: 0, converted: 0 }, executives: [] };
    }

    const remarks = await CallRemark.findAll({
      where: { campaignLeadId: { [Op.in]: clIds } },
      include: [{ model: User, as: 'executive', attributes: ['id', 'firstName', 'lastName'] }]
    });

    const outcomes = {};
    Object.values(CALL_OUTCOME).forEach((o) => {
      outcomes[o] = 0;
    });
    remarks.forEach((r) => {
      outcomes[r.callOutcome] = (outcomes[r.callOutcome] || 0) + 1;
    });

    // Funnel counts distinct LEADS, not remarks — a lead called three times
    // is one person reached, not three.
    const leadsWithRemark = new Set(remarks.map((r) => r.campaignLeadId));
    const reachedLeads = new Set(
      remarks.filter((r) => r.callOutcome === CALL_OUTCOME.ANSWERED).map((r) => r.campaignLeadId)
    );
    const confirmedRemarks = remarks.filter((r) => r.conversionConfirmed === true);
    const convertedLeads = new Set(confirmedRemarks.map((r) => r.campaignLeadId));

    const byExec = {};
    remarks.forEach((r) => {
      const key = r.executiveUserId;
      if (!byExec[key]) {
        byExec[key] = {
          executiveId: key,
          name: r.executive ? `${r.executive.firstName} ${r.executive.lastName}` : 'Unknown',
          callsLogged: 0,
          totalDuration: 0,
          durationSamples: 0,
          conversionsClaimed: 0,
          conversionsConfirmed: 0
        };
      }
      const e = byExec[key];
      e.callsLogged += 1;
      if (r.callDurationMinutes != null) {
        e.totalDuration += r.callDurationMinutes;
        e.durationSamples += 1;
      }
      if (r.callOutcome === CALL_OUTCOME.CONVERTED) {
        e.conversionsClaimed += 1;
        if (r.conversionConfirmed === true) e.conversionsConfirmed += 1;
      }
    });

    return {
      queue,
      outcomes,
      funnel: {
        total: campaignLeads.length,
        called: leadsWithRemark.size,
        reached: reachedLeads.size,
        converted: convertedLeads.size
      },
      totalCalls: remarks.length,
      averageDurationMinutes: (() => {
        const withDuration = remarks.filter((r) => r.callDurationMinutes != null);
        if (!withDuration.length) return null;
        return Number(
          (withDuration.reduce((s, r) => s + r.callDurationMinutes, 0) / withDuration.length).toFixed(1)
        );
      })(),
      executives: Object.values(byExec).map((e) => ({
        executiveId: e.executiveId,
        name: e.name,
        callsLogged: e.callsLogged,
        averageDurationMinutes: e.durationSamples
          ? Number((e.totalDuration / e.durationSamples).toFixed(1))
          : null,
        conversionsClaimed: e.conversionsClaimed,
        conversionsConfirmed: e.conversionsConfirmed
      }))
    };
  }

  /**
   * Billing. Only CONFIRMED conversions ever count — for calls that means
   * a second person verified the claim; for email the lead's own CTA click
   * is self-evident and needs no confirmation.
   */
  async billing(campaign) {
    if (!campaign.pricingModel) return null;

    const confirmed =
      campaign.type === CAMPAIGN_TYPE.CALL
        ? (await this.callMetrics(campaign)).funnel.converted
        : (await this.emailMetrics(campaign)).converted;

    if (campaign.pricingModel === 'cost_per_lead') {
      const rateValue = Number(campaign.ratePerLead);
      return {
        pricingModel: 'cost_per_lead',
        ratePerLead: rateValue,
        confirmedConversions: confirmed,
        amountAccrued: Number((confirmed * rateValue).toFixed(2))
      };
    }

    const retainer = Number(campaign.retainerAmount);
    return {
      pricingModel: 'flat_retainer',
      retainerAmount: retainer,
      confirmedConversions: confirmed,
      costPerConversion: confirmed ? Number((retainer / confirmed).toFixed(2)) : null
    };
  }

  /**
   * Lead-level rows for the Excel export.
   *
   * `viewerRole` is what enforces the client visibility rule centrally: a
   * client gets aggregate counts for everyone but contact details only for
   * Qualified/Converted leads. Everyone else's row is still present (so the
   * totals reconcile) with its identifying fields withheld.
   */
  async leadRows(campaign, viewerRole) {
    const campaignLeads = await CampaignLead.findAll({
      where: { campaignId: campaign.id },
      include: [
        { model: Lead, as: 'lead' },
        { model: User, as: 'assignedExecutive', attributes: ['firstName', 'lastName'] }
      ],
      order: [['addedAt', 'ASC']]
    });
    if (campaignLeads.length === 0) return [];

    const leadIds = campaignLeads.map((cl) => cl.leadId);
    const memberships = await LeadListMembership.findAll({
      where: { leadListId: campaign.leadListId, leadId: { [Op.in]: leadIds } }
    });
    const statusByLead = new Map(memberships.map((m) => [m.leadId, m.status]));

    const isClient = viewerRole === ROLES.CLIENT;
    const clIds = campaignLeads.map((cl) => cl.id);

    const engagements =
      campaign.type === CAMPAIGN_TYPE.EMAIL
        ? await LeadEngagement.findAll({ where: { campaignLeadId: { [Op.in]: clIds } } })
        : [];
    const engByCl = new Map(engagements.map((e) => [e.campaignLeadId, e]));

    const remarks =
      campaign.type === CAMPAIGN_TYPE.CALL
        ? await CallRemark.findAll({
            where: { campaignLeadId: { [Op.in]: clIds } },
            include: [{ model: User, as: 'executive', attributes: ['firstName', 'lastName'] }],
            order: [['createdAt', 'ASC']]
          })
        : [];
    const remarksByCl = remarks.reduce((acc, r) => {
      (acc[r.campaignLeadId] = acc[r.campaignLeadId] || []).push(r);
      return acc;
    }, {});

    const rows = [];
    campaignLeads.forEach((cl) => {
      const status = statusByLead.get(cl.leadId) || MEMBERSHIP_STATUS.NEW;
      const visible = !isClient || CLIENT_VISIBLE_STATUSES.includes(status);

      const identity = visible
        ? {
            firstName: cl.lead.firstName,
            lastName: cl.lead.lastName,
            email: cl.lead.email,
            phone: cl.lead.phone,
            company: cl.lead.company,
            jobTitle: cl.lead.jobTitle
          }
        : {
            firstName: '(withheld)',
            lastName: '',
            email: '(withheld)',
            phone: '(withheld)',
            company: '(withheld)',
            jobTitle: ''
          };

      if (campaign.type === CAMPAIGN_TYPE.EMAIL) {
        const eng = engByCl.get(cl.id);
        rows.push({
          ...identity,
          status,
          sentAt: eng && eng.sentAt,
          openedAt: eng && eng.openedAt,
          openCount: eng ? eng.openCount : 0,
          clickedAt: eng && eng.clickedAt,
          clickCount: eng ? eng.clickCount : 0,
          convertedAt: eng && eng.convertedAt,
          unsubscribedAt: eng && eng.unsubscribedAt,
          bounceType: eng && eng.bounceType
        });
      } else {
        const leadRemarks = remarksByCl[cl.id] || [];
        if (leadRemarks.length === 0) {
          rows.push({ ...identity, status, queueStatus: cl.queueStatus, callOutcome: null });
        } else {
          leadRemarks.forEach((r) => {
            rows.push({
              ...identity,
              status,
              queueStatus: cl.queueStatus,
              callOutcome: r.callOutcome,
              callDurationMinutes: r.callDurationMinutes,
              // Free-text notes are internal working notes about the
              // prospect — never exposed to the client.
              notes: isClient ? '(internal)' : r.notes,
              followUpDate: r.followUpDate,
              executiveName: r.executive ? `${r.executive.firstName} ${r.executive.lastName}` : '',
              conversionConfirmed: r.conversionConfirmed,
              loggedAt: r.createdAt
            });
          });
        }
      }
    });

    return rows;
  }

  /**
   * Plain-language observations derived from the metrics (SRS 4.9.1).
   * Deliberately factual rather than advisory — the report states what
   * happened; interpreting it is the account manager's job.
   */
  observations(campaign, metrics) {
    const notes = [];
    if (campaign.type === CAMPAIGN_TYPE.EMAIL) {
      const r = metrics.rates || {};
      if (metrics.sent === 0) return ['This campaign has not been dispatched yet.'];
      if (r.bounceRate > 10) {
        notes.push(
          `Bounce rate of ${r.bounceRate}% is above the 10% threshold, which can affect sending reputation. This usually indicates a stale or poorly sourced list.`
        );
      }
      if (r.unsubscribeRate > 5) {
        notes.push(
          `Unsubscribe rate of ${r.unsubscribeRate}% is above the 5% threshold, which often signals a targeting or messaging mismatch.`
        );
      }
      if (r.openRate >= 20) notes.push(`Open rate of ${r.openRate}% is healthy for B2B outreach.`);
      else if (r.openRate > 0) notes.push(`Open rate of ${r.openRate}% is below the typical B2B range.`);
      if (metrics.converted > 0) {
        notes.push(`${metrics.converted} recipient(s) responded to the interest call-to-action.`);
      }
    } else {
      if (metrics.totalCalls === 0) return ['No calls have been logged for this campaign yet.'];
      notes.push(`${metrics.totalCalls} call(s) logged against ${metrics.funnel.called} lead(s).`);
      if (metrics.funnel.reached > 0) {
        notes.push(
          `${metrics.funnel.reached} lead(s) were reached directly (${rate(metrics.funnel.reached, metrics.funnel.total)}% of the audience).`
        );
      }
      if (metrics.funnel.converted > 0) {
        notes.push(`${metrics.funnel.converted} conversion(s) have been confirmed by a manager.`);
      }
      const unconfirmed = metrics.executives.reduce(
        (s, e) => s + (e.conversionsClaimed - e.conversionsConfirmed),
        0
      );
      if (unconfirmed > 0) {
        notes.push(`${unconfirmed} claimed conversion(s) are still awaiting manager review and are not yet billable.`);
      }
    }
    return notes.length ? notes : ['No notable observations for this campaign yet.'];
  }

  /** Everything a report needs, assembled once. */
  async fullReport(campaignId, user) {
    const campaign = await this.assertAccess(campaignId, user);
    const summary = await this.summary(campaign);
    const metrics =
      campaign.type === CAMPAIGN_TYPE.EMAIL
        ? await this.emailMetrics(campaign)
        : await this.callMetrics(campaign);
    const billing = await this.billing(campaign);

    return {
      campaign,
      summary,
      metrics,
      billing,
      observations: this.observations(campaign, metrics)
    };
  }
}

module.exports = new ReportDataService();
module.exports.CLIENT_VISIBLE_STATUSES = CLIENT_VISIBLE_STATUSES;
