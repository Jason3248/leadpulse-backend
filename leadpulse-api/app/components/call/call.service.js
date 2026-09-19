'use strict';

const {
  Campaign,
  CampaignExecutive,
  CampaignLead,
  CallRemark,
  Client,
  Lead,
  User,
  sequelize,
  Sequelize,
  constants
} = require('leadpulse-data-model');
const { NotFoundError, BusinessRuleError, ForbiddenError } = require('../../lib');
const { updateLeadStatus, checkContactable } = require('../lead/leadStatus.service.js');
const assertClientOwnership = require('../client/assertClientOwnership.js');
const { recordConversion, campaignBilling } = require('../sequence/sequenceBilling.service.js');
const notifications = require('../notification/notification.service.js');
const logger = require('../../configs/logger.js');

const { Op } = Sequelize;
const { CAMPAIGN_STATUS, CAMPAIGN_TYPE, QUEUE_STATUS, MEMBERSHIP_STATUS, CALL_OUTCOME, ROLES } = constants;

// Outcomes that resolve a lead outright — nothing further to do in this
// campaign. "Callback Requested" deliberately isn't here: it leaves the lead
// in_progress so the campaign stays open until it's genuinely worked.
const TERMINAL_OUTCOMES = [
  CALL_OUTCOME.WRONG_NUMBER,
  CALL_OUTCOME.NOT_INTERESTED,
  CALL_OUTCOME.CONVERTED
];

const toCallCard = (campaignLead, lead, previousRemarks) => ({
  campaignLeadId: campaignLead.id,
  leadId: lead.id,
  firstName: lead.firstName,
  lastName: lead.lastName,
  company: lead.company,
  jobTitle: lead.jobTitle,
  phone: lead.phone,
  email: lead.email,
  industry: lead.industry,
  queueStatus: campaignLead.queueStatus,
  // Prior attempts on this same lead in this same campaign, so the executive
  // isn't calling blind on a re-call.
  previousRemarks: previousRemarks.map((r) => ({
    callOutcome: r.callOutcome,
    notes: r.notes,
    followUpDate: r.followUpDate,
    createdAt: r.createdAt
  }))
});

class CallService
{
  /**
   * Daily aggregated metrics for the executive across all their assigned campaigns.
   */
  async myMetrics(executiveUserId) {
    // 1. Pending Leads (across all active campaigns assigned to them)
    const pendingLeads = await CampaignLead.count({
      include: [{
        model: Campaign,
        as: 'campaign',
        where: { status: CAMPAIGN_STATUS.ACTIVE, type: CAMPAIGN_TYPE.CALL }
      }],
      where: {
        assignedExecutiveId: executiveUserId,
        queueExhausted: false
      }
    });

    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);
    const endOfToday = new Date();
    endOfToday.setHours(23, 59, 59, 999);

    // 2. Calls Made Today
    // We join via CampaignLead to ensure it's their lead, though normally an exec only
    // remarks on their own leads anyway.
    const callsMadeToday = await CallRemark.count({
      include: [{
        model: CampaignLead,
        as: 'campaignLead',
        where: { assignedExecutiveId: executiveUserId }
      }],
      where: {
        createdAt: { [Op.between]: [startOfToday, endOfToday] }
      }
    });

    // 3. Conversions Claimed Today
    const conversionsClaimedToday = await CallRemark.count({
      include: [{
        model: CampaignLead,
        as: 'campaignLead',
        where: { assignedExecutiveId: executiveUserId }
      }],
      where: {
        callOutcome: CALL_OUTCOME.CONVERTED,
        createdAt: { [Op.between]: [startOfToday, endOfToday] }
      }
    });

    // 4. Overdue Callbacks
    // Similar to callbacksDue but across all their campaigns
    const now = new Date();
    const remarks = await CallRemark.findAll({
      attributes: ['id', 'callOutcome', 'followUpDate', 'campaignLeadId'],
      include: [
        {
          model: CampaignLead,
          as: 'campaignLead',
          where: { assignedExecutiveId: executiveUserId, queueExhausted: false },
          include: [{
            model: Campaign,
            as: 'campaign',
            where: { status: CAMPAIGN_STATUS.ACTIVE }
          }]
        }
      ],
      order: [['createdAt', 'DESC']]
    });
    
    let overdueCallbacksCount = 0;
    const seenLeads = new Set();
    
    for (const rm of remarks) {
      if (!seenLeads.has(rm.campaignLeadId)) {
        seenLeads.add(rm.campaignLeadId);
        if (rm.callOutcome === CALL_OUTCOME.CALLBACK_REQUESTED && rm.followUpDate && new Date(rm.followUpDate) <= now) {
          overdueCallbacksCount++;
        }
      }
    }

    return {
      callsMadeToday,
      conversionsClaimedToday,
      totalPendingLeads: pendingLeads,
      overdueCallbacksCount
    };
  }

  /**
   * Serve the next lead in this executive's slice of the queue.
   *
   * Every candidate is run through the live contactability check before
   * being shown. A lead who became uncontactable since approval — converted
   * via a concurrent campaign, or newly marked DNC — is skipped on the spot
   * (queue_status -> skipped) and the loop moves on, rather than being
   * presented to the executive to call.
   */
  async getNextLead(campaignId, executiveUserId)
  {
    const { campaign } = await this._assertExecutiveOnCampaign(campaignId, executiveUserId);

    if (campaign.status !== CAMPAIGN_STATUS.ACTIVE)
    {
      throw new BusinessRuleError(`This campaign is ${campaign.status} — its queue is not open.`);
    }

    const cooldownMinutes = parseInt(process.env.COOLDOWN_MINUTES || '30', 10);
    const cooldownThreshold = new Date(Date.now() - cooldownMinutes * 60 * 1000);

    // Bounded loop: each iteration either returns a card or retires one
    // uncontactable lead, so it always terminates.
    // eslint-disable-next-line no-constant-condition
    while (true)
    {
      // Queue ordering, two priority tiers:
      //   1. PENDING (never attempted) — highest priority, oldest first.
      //   2. CALLED / IN_PROGRESS (attempted, unresolved) — re-served, but
      //      LEAST-RECENTLY-WORKED first, so a lead you just marked
      //      "Not Answered" drops to the BACK of the queue rather than being
      //      handed straight back to you. Without this the oldest unresolved
      //      lead is "sticky": you'd get the same person on every call until
      //      they reach a terminal outcome, and never progress through the
      //      rest of the queue.
      //
      // "Last worked" is derived from the newest call_remark for each row —
      // pending leads have none, which is why they sort first here (NULL is
      // treated as the earliest possible time by the coalesce below).
      const next = await CampaignLead.findOne({
        where: {
          campaignId,
          assignedExecutiveId: executiveUserId,
          queueStatus: { [Op.in]: [QUEUE_STATUS.PENDING, QUEUE_STATUS.IN_PROGRESS, QUEUE_STATUS.CALLED] },
          [Op.and]: [
            // Cooldown: skip leads worked in the last X minutes
            sequelize.where(
              sequelize.literal(
                '(SELECT GREATEST((SELECT MAX(cr.created_at) FROM call_remarks cr WHERE cr.campaign_lead_id = "CampaignLead"."id"), "CampaignLead"."last_skipped_at"))'
              ),
              {
                [Op.or]: {
                  [Op.lt]: cooldownThreshold,
                  [Op.is]: null
                }
              }
            ),
            // Callback: if there is a scheduled callback, don't show until it's due
            sequelize.where(
              sequelize.literal(`(
                SELECT cr.follow_up_date 
                FROM call_remarks cr 
                WHERE cr.campaign_lead_id = "CampaignLead"."id" 
                ORDER BY cr.created_at DESC 
                LIMIT 1
              )`),
              {
                [Op.or]: {
                  [Op.lte]: new Date(),
                  [Op.is]: null
                }
              }
            )
          ]
        },
        attributes: {
          include: [
            [
              sequelize.literal(
                '(SELECT GREATEST((SELECT MAX(cr.created_at) FROM call_remarks cr WHERE cr.campaign_lead_id = "CampaignLead"."id"), "CampaignLead"."last_skipped_at"))'
              ),
              'lastWorkedAt'
            ]
          ]
        },
        order: [
          // Never-worked leads (lastWorkedAt IS NULL) come first, then the
          // rest ordered by how long ago they were last worked (ascending).
          [sequelize.literal('"lastWorkedAt" ASC NULLS FIRST')],
          // Stable tie-breaker for two leads with the same (or no) remark time.
          ['addedAt', 'ASC']
        ]
      });

      if (!next)
      {
        // This executive's slice is empty. If the WHOLE campaign is now
        // resolved (every executive's leads included), the campaign has
        // genuinely completed by exhaustion — transition it and tell the
        // manager. Checked here because this is the only moment we know a
        // queue just ran dry; nothing else polls for it.
        await this._completeIfExhausted(campaign);
        return null;
      }

      const { contactable, reason } = await checkContactable({
        clientId: campaign.clientId,
        leadListId: campaign.leadListId,
        leadId: next.leadId,
        channel: CAMPAIGN_TYPE.CALL,
        excludeClosedLeads: campaign.excludeClosedLeads
      });

      if (!contactable)
      {
        logger.info('Skipping uncontactable lead in call queue', { campaignId, leadId: next.leadId, reason });
        await next.update({ queueStatus: QUEUE_STATUS.SKIPPED });
        continue;
      }

      const lead = await Lead.findByPk(next.leadId);
      const previousRemarks = await CallRemark.findAll({
        where: { campaignLeadId: next.id },
        order: [['createdAt', 'DESC']]
      });

      return toCallCard(next, lead, previousRemarks);
    }
  }

  /**
   * Session history for the executive in this campaign.
   * Returns up to 20 recently worked leads in descending order of activity.
   */
  async getHistory(campaignId, executiveUserId)
  {
    const { campaign } = await this._assertExecutiveOnCampaign(campaignId, executiveUserId);

    const history = await CampaignLead.findAll({
      where: {
        campaignId,
        assignedExecutiveId: executiveUserId,
        [Op.or]: [
          { queueStatus: { [Op.ne]: QUEUE_STATUS.PENDING } },
          { lastSkippedAt: { [Op.ne]: null } }
        ]
      },
      attributes: {
        include: [
          [
            sequelize.literal(
              '(SELECT GREATEST((SELECT MAX(cr.created_at) FROM call_remarks cr WHERE cr.campaign_lead_id = "CampaignLead"."id"), "CampaignLead"."last_skipped_at"))'
            ),
            'lastWorkedAt'
          ]
        ]
      },
      order: [[sequelize.literal('"lastWorkedAt"'), 'DESC']],
      limit: 20
    });

    return Promise.all(history.map(async (cl) => {
      const lead = await Lead.findByPk(cl.leadId);
      const previousRemarks = await CallRemark.findAll({
        where: { campaignLeadId: cl.id },
        order: [['createdAt', 'DESC']]
      });
      return toCallCard(cl, lead, previousRemarks);
    }));
  }

  /**
   * Log the outcome of a call attempt and advance the queue.
   *
   * Status side-effects are deliberately asymmetric:
   *   - "Not Interested" -> Dead automatically. An explicit human "no" is a
   *     definite negative signal, same class as an email unsubscribe.
   *   - "Converted"      -> NOT applied here. The lead's status only becomes
   *     Converted once a second person confirms the claim (see
   *     reviewConversion), so an unverified claim never reaches the client
   *     portal or the billing count.
   *   - anything else    -> at least Contacted, since an attempt was made.
   */
  async logRemark(campaignLeadId, executiveUserId, data)
  {
    const { campaignLead, campaign } = await this._assertExecutiveOnCampaignLead(campaignLeadId, executiveUserId);

    if (campaign.status !== CAMPAIGN_STATUS.ACTIVE)
    {
      throw new BusinessRuleError(`This campaign is ${campaign.status} — remarks cannot be logged.`);
    }
    if ([QUEUE_STATUS.COMPLETED, QUEUE_STATUS.SKIPPED].includes(campaignLead.queueStatus))
    {
      throw new BusinessRuleError('This lead has already been resolved in this campaign.');
    }

    const remark = await sequelize.transaction(async (transaction) =>
    {
      const created = await CallRemark.create(
        {
          campaignLeadId,
          executiveUserId,
          callOutcome: data.callOutcome,
          callDurationMinutes: data.callDurationMinutes ?? null,
          notes: data.notes || null,
          followUpDate: data.followUpDate || null,
          leadStatusUpdate: data.leadStatusUpdate || null
        },
        { transaction }
      );

      const pastAttempts = await CallRemark.count({ where: { campaignLeadId }, transaction });

      const queueStatus = TERMINAL_OUTCOMES.includes(data.callOutcome) || pastAttempts >= 4
        ? QUEUE_STATUS.COMPLETED
        : data.callOutcome === CALL_OUTCOME.CALLBACK_REQUESTED
          ? QUEUE_STATUS.IN_PROGRESS
          : QUEUE_STATUS.CALLED;
      await campaignLead.update({ queueStatus }, { transaction });

      // Resolve the membership status change for this outcome.
      let newStatus = null;
      if (data.callOutcome === CALL_OUTCOME.NOT_INTERESTED)
      {
        newStatus = MEMBERSHIP_STATUS.DEAD;
      } else if (data.leadStatusUpdate)
      {
        newStatus = data.leadStatusUpdate;
      } else if (data.callOutcome !== CALL_OUTCOME.CONVERTED)
      {
        newStatus = MEMBERSHIP_STATUS.CONTACTED;
      }

      if (newStatus)
      {
        // Automatic — the forward-only guard inside updateLeadStatus stops a
        // later "Not Answered" from demoting someone already Qualified.
        await updateLeadStatus({
          leadListId: campaign.leadListId,
          leadId: campaignLead.leadId,
          newStatus,
          isManualOverride: false,
          transaction
        });
      }

      return created;
    });

    return {
      id: remark.id,
      callOutcome: remark.callOutcome,
      queueStatus: campaignLead.queueStatus,
      awaitingConversionReview: data.callOutcome === CALL_OUTCOME.CONVERTED
    };
  }

  /**
   * Manager review of a claimed conversion — the billing trust gate.
   *
   * Confirming is what actually promotes the lead to Converted and makes it
   * countable for cost-per-lead billing. Rejecting records who rejected it
   * and why, and leaves the lead's status untouched so it can still be
   * worked. The DB enforces that the reviewer is never the reporting
   * executive, and that only one confirmed conversion exists per frozen
   * audience row.
   */
  async reviewConversion(remarkId, managerId, { confirmed, rejectionReason })
  {
    const remark = await CallRemark.findByPk(remarkId, {
      include: [{ model: CampaignLead, as: 'campaignLead' }]
    });
    if (!remark) throw new NotFoundError('Call remark not found.');

    const campaign = await Campaign.findByPk(remark.campaignLead.campaignId);
    if (!campaign) throw new NotFoundError('Call remark not found.');
    await assertClientOwnership(campaign.clientId, managerId, { requireActive: true });

    if (remark.callOutcome !== CALL_OUTCOME.CONVERTED)
    {
      throw new BusinessRuleError('Only a remark with a "Converted" outcome can be reviewed.');
    }
    if (remark.conversionConfirmed !== null)
    {
      throw new BusinessRuleError('This conversion has already been reviewed.');
    }
    if (remark.executiveUserId === managerId)
    {
      throw new BusinessRuleError('A conversion cannot be reviewed by the person who reported it.');
    }

    await sequelize.transaction(async (transaction) =>
    {
      await remark.update(
        {
          conversionConfirmed: confirmed,
          conversionRejectionReason: confirmed ? null : rejectionReason,
          confirmedByUserId: managerId,
          confirmedAt: new Date()
        },
        { transaction }
      );

      if (confirmed)
      {
        await updateLeadStatus({
          leadListId: campaign.leadListId,
          leadId: remark.campaignLead.leadId,
          newStatus: MEMBERSHIP_STATUS.CONVERTED,
          isManualOverride: false,
          transaction
        });

        // Ledger the conversion for billing. If this lead already converted
        // at an earlier step of the same sequence, this is a no-op — the
        // client is billed once per lead per sequence, never per step.
        await recordConversion({
          campaign,
          leadId: remark.campaignLead.leadId,
          channel: 'call',
          transaction
        });
      }
    });

    return {
      id: remark.id,
      conversionConfirmed: confirmed,
      conversionRejectionReason: confirmed ? null : rejectionReason
    };
  }

  async globalPendingConversions(managerId) {
    // Get all campaigns owned by this manager
    const ownedClientIds = (await Client.findAll({ where: { managerId }, attributes: ['id'] })).map(c => c.id);
    if (ownedClientIds.length === 0) return [];
    
    const campaigns = await Campaign.findAll({ 
      where: { clientId: { [Op.in]: ownedClientIds }, type: CAMPAIGN_TYPE.CALL },
      attributes: ['id', 'name']
    });
    const campaignIds = campaigns.map(c => c.id);
    if (campaignIds.length === 0) return [];

    const remarks = await CallRemark.findAll({
      where: {
        callOutcome: CALL_OUTCOME.CONVERTED,
        conversionConfirmed: null
      },
      include: [
        { 
          model: CampaignLead, 
          as: 'campaignLead', 
          where: { campaignId: { [Op.in]: campaignIds } },
          include: [
            { model: Lead, as: 'lead' },
            { model: Campaign, as: 'campaign', attributes: ['id', 'name'] }
          ] 
        },
        { model: User, as: 'executive', attributes: ['id', 'firstName', 'lastName'] }
      ],
      order: [['createdAt', 'ASC']]
    });

    return remarks.map((r) => ({
      remarkId: r.id,
      campaignId: r.campaignLead.campaign.id,
      campaignName: r.campaignLead.campaign.name,
      leadId: r.campaignLead.leadId,
      leadName: `${r.campaignLead.lead.firstName} ${r.campaignLead.lead.lastName || ''}`.trim(),
      company: r.campaignLead.lead.company,
      notes: r.notes,
      reportedBy: `${r.executive.firstName} ${r.executive.lastName}`,
      reportedAt: r.createdAt
    }));
  }

  async globalCallbacksDue(managerId) {
    const ownedClientIds = (await Client.findAll({ where: { managerId }, attributes: ['id'] })).map(c => c.id);
    if (ownedClientIds.length === 0) return [];

    const campaigns = await Campaign.findAll({ 
      where: { clientId: { [Op.in]: ownedClientIds }, type: CAMPAIGN_TYPE.CALL },
      attributes: ['id', 'name']
    });
    const campaignIds = campaigns.map(c => c.id);
    if (campaignIds.length === 0) return [];

    const campaignLeads = await CampaignLead.findAll({
      where: { campaignId: { [Op.in]: campaignIds } },
      include: [
        { model: Lead, as: 'lead' },
        { model: Campaign, as: 'campaign', attributes: ['id', 'name'] }
      ]
    });
    if (campaignLeads.length === 0) return [];

    const now = new Date();
    const due = [];

    for (const cl of campaignLeads) {
      const latest = await CallRemark.findOne({
        where: { campaignLeadId: cl.id },
        order: [['createdAt', 'DESC']]
      });
      if (!latest) continue;
      if (latest.callOutcome !== CALL_OUTCOME.CALLBACK_REQUESTED) continue;
      if (!latest.followUpDate || new Date(latest.followUpDate) > now) continue;

      due.push({
        campaignId: cl.campaign.id,
        campaignName: cl.campaign.name,
        campaignLeadId: cl.id,
        leadId: cl.leadId,
        leadName: `${cl.lead.firstName} ${cl.lead.lastName || ''}`.trim(),
        company: cl.lead.company,
        phone: cl.lead.phone,
        followUpDate: latest.followUpDate,
        notes: latest.notes,
        overdue: new Date(latest.followUpDate) < now
      });
    }

    return due.sort((a, b) => a.followUpDate.localeCompare(b.followUpDate));
  }

  /** Conversions claimed but not yet reviewed — the manager's review inbox. */
  async pendingConversions(campaignId, managerId)
  {
    const campaign = await this._assertManagerOnCampaign(campaignId, managerId);

    const campaignLeadIds = (
      await CampaignLead.findAll({ where: { campaignId: campaign.id }, attributes: ['id'] })
    ).map((cl) => cl.id);
    if (campaignLeadIds.length === 0) return [];

    const remarks = await CallRemark.findAll({
      where: {
        campaignLeadId: { [Op.in]: campaignLeadIds },
        callOutcome: CALL_OUTCOME.CONVERTED,
        conversionConfirmed: null
      },
      include: [
        { model: CampaignLead, as: 'campaignLead', include: [{ model: Lead, as: 'lead' }] },
        { model: User, as: 'executive', attributes: ['id', 'firstName', 'lastName'] }
      ],
      order: [['createdAt', 'ASC']]
    });

    return remarks.map((r) => ({
      remarkId: r.id,
      leadId: r.campaignLead.leadId,
      leadName: `${r.campaignLead.lead.firstName} ${r.campaignLead.lead.lastName || ''}`.trim(),
      company: r.campaignLead.lead.company,
      notes: r.notes,
      reportedBy: `${r.executive.firstName} ${r.executive.lastName}`,
      reportedAt: r.createdAt
    }));
  }

  /**
   * Callbacks that are due or overdue.
   *
   * Only the MOST RECENT remark per lead counts: if a later call superseded
   * a scheduled callback, that callback is stale and must not still appear
   * as outstanding. Read-only by design — nothing here forces or schedules
   * anything.
   */
  async callbacksDue(campaignId, user)
  {
    const campaign =
      user.role === ROLES.EXECUTIVE
        ? (await this._assertExecutiveOnCampaign(campaignId, user.id)).campaign
        : await this._assertManagerOnCampaign(campaignId, user.id);

    const clWhere = { campaignId: campaign.id };
    if (user.role === ROLES.EXECUTIVE) clWhere.assignedExecutiveId = user.id;

    const campaignLeads = await CampaignLead.findAll({
      where: clWhere,
      include: [{ model: Lead, as: 'lead' }]
    });
    if (campaignLeads.length === 0) return [];

    const now = new Date();
    const due = [];

    for (const cl of campaignLeads)
    {
      const latest = await CallRemark.findOne({
        where: { campaignLeadId: cl.id },
        order: [['createdAt', 'DESC']]
      });
      if (!latest) continue;
      if (latest.callOutcome !== CALL_OUTCOME.CALLBACK_REQUESTED) continue; // superseded
      if (!latest.followUpDate || new Date(latest.followUpDate) > now) continue; // not due yet

      due.push({
        campaignLeadId: cl.id,
        leadId: cl.leadId,
        leadName: `${cl.lead.firstName} ${cl.lead.lastName || ''}`.trim(),
        company: cl.lead.company,
        phone: cl.lead.phone,
        followUpDate: latest.followUpDate,
        notes: latest.notes,
        overdue: new Date(latest.followUpDate) < now
      });
    }

    return due.sort((a, b) => a.followUpDate.localeCompare(b.followUpDate));
  }

  /** Manager rollup across every assigned executive on a call campaign. */
  async progress(campaignId, managerId)
  {
    const campaign = await this._assertManagerOnCampaign(campaignId, managerId);

    const campaignLeads = await CampaignLead.findAll({ where: { campaignId: campaign.id } });
    const counts = { total: campaignLeads.length, pending: 0, in_progress: 0, called: 0, completed: 0, skipped: 0 };
    campaignLeads.forEach((cl) =>
    {
      if (counts[cl.queueStatus] !== undefined) counts[cl.queueStatus] += 1;
    });

    const byExecutive = {};
    const clIds = campaignLeads.map((cl) => cl.id);
    const remarks = clIds.length
      ? await CallRemark.findAll({
        where: { campaignLeadId: { [Op.in]: clIds } },
        include: [{ model: User, as: 'executive', attributes: ['id', 'firstName', 'lastName'] }]
      })
      : [];

    remarks.forEach((r) =>
    {
      const key = r.executiveUserId;
      if (!byExecutive[key])
      {
        byExecutive[key] = {
          executiveId: key,
          name: `${r.executive.firstName} ${r.executive.lastName}`,
          callsLogged: 0,
          totalDuration: 0,
          durationSamples: 0,
          conversionsClaimed: 0,
          conversionsConfirmed: 0
        };
      }
      const e = byExecutive[key];
      e.callsLogged += 1;
      if (r.callDurationMinutes != null)
      {
        e.totalDuration += r.callDurationMinutes;
        e.durationSamples += 1;
      }
      if (r.callOutcome === CALL_OUTCOME.CONVERTED)
      {
        e.conversionsClaimed += 1;
        if (r.conversionConfirmed === true) e.conversionsConfirmed += 1;
      }
    });

    const executives = Object.values(byExecutive).map((e) => ({
      executiveId: e.executiveId,
      name: e.name,
      callsLogged: e.callsLogged,
      averageDurationMinutes: e.durationSamples ? Math.round((e.totalDuration / e.durationSamples) * 10) / 10 : null,
      conversionsClaimed: e.conversionsClaimed,
      conversionsConfirmed: e.conversionsConfirmed
    }));

    // Billing is delegated so sequence steps roll up to the sequence and
    // standalone campaigns bill alone — a step must never show its own
    // "amount owed", or a 3-step motion would appear to owe 3 times.
    const billing = await campaignBilling(campaign);

    return { queue: counts, executives, billing };
  }

  /** Campaigns this executive is actively assigned to. */
  async myCampaigns(executiveUserId)
  {
    const assignments = await CampaignExecutive.findAll({
      where: { executiveUserId, isActive: true },
      attributes: ['campaignId']
    });
    const ids = assignments.map((a) => a.campaignId);
    if (ids.length === 0) return [];

    const campaigns = await Campaign.findAll({
      where: { id: { [Op.in]: ids }, type: CAMPAIGN_TYPE.CALL },
      include: [{ model: Client, as: 'client', attributes: ['id', 'name'] }],
      order: [['createdAt', 'DESC']]
    });

    return Promise.all(
      campaigns.map(async (c) => ({
        id: c.id,
        name: c.name,
        clientName: c.client.name,
        status: c.status,
        myPendingLeads: await CampaignLead.count({
          where: {
            campaignId: c.id,
            assignedExecutiveId: executiveUserId,
            queueStatus: { [Op.in]: [QUEUE_STATUS.PENDING, QUEUE_STATUS.IN_PROGRESS] }
          }
        })
      }))
    );
  }

  /**
   * Transitions a call campaign to completed once every lead across every
   * assigned executive has reached a terminal queue state. This is the
   * "complete by exhaustion" rule made real — without it a finished
   * campaign would sit as 'active' forever waiting for a manager to close
   * it manually.
   */
  async _completeIfExhausted(campaign)
  {
    if (campaign.status !== CAMPAIGN_STATUS.ACTIVE) return;

    const openLeads = await CampaignLead.count({
      where: {
        campaignId: campaign.id,
        queueStatus: {
          [Op.in]: [QUEUE_STATUS.PENDING, QUEUE_STATUS.IN_PROGRESS, QUEUE_STATUS.CALLED]
        }
      }
    });
    if (openLeads > 0) return;

    await campaign.update({ status: CAMPAIGN_STATUS.COMPLETED });
    logger.info('Call campaign completed by exhaustion', { campaignId: campaign.id });

    const manager = await User.findByPk(campaign.createdByUserId);
    if (!manager) return;

    const campaignLeadIds = (
      await CampaignLead.findAll({ where: { campaignId: campaign.id }, attributes: ['id'] })
    ).map((cl) => cl.id);

    const [callsLogged, confirmedConversions] = await Promise.all([
      CallRemark.count({ where: { campaignLeadId: { [Op.in]: campaignLeadIds } } }),
      CallRemark.count({ where: { campaignLeadId: { [Op.in]: campaignLeadIds }, conversionConfirmed: true } })
    ]);

    await notifications.callCampaignCompleted(manager, campaign, { callsLogged, confirmedConversions });
  }

  async _assertExecutiveOnCampaign(campaignId, executiveUserId)
  {
    const campaign = await Campaign.findByPk(campaignId);
    if (!campaign) throw new NotFoundError('Campaign not found.');
    if (campaign.type !== CAMPAIGN_TYPE.CALL)
    {
      throw new BusinessRuleError('This is not a call campaign.');
    }

    const assignment = await CampaignExecutive.findOne({
      where: { campaignId, executiveUserId, isActive: true }
    });
    if (!assignment) throw new NotFoundError('Campaign not found.');

    // A deactivated client freezes new work but never blocks reads.
    const client = await Client.findByPk(campaign.clientId);
    if (!client || !client.isActive)
    {
      throw new ForbiddenError('This client account has been deactivated.');
    }

    return { campaign, assignment };
  }

  async _assertExecutiveOnCampaignLead(campaignLeadId, executiveUserId)
  {
    const campaignLead = await CampaignLead.findByPk(campaignLeadId);
    if (!campaignLead) throw new NotFoundError('Lead not found in this campaign.');

    // The lead must be in this executive's own slice — one executive can't
    // log a remark against another's assigned lead.
    if (campaignLead.assignedExecutiveId !== executiveUserId)
    {
      throw new NotFoundError('Lead not found in this campaign.');
    }

    const { campaign } = await this._assertExecutiveOnCampaign(campaignLead.campaignId, executiveUserId);
    return { campaignLead, campaign };
  }

  async _assertManagerOnCampaign(campaignId, managerId)
  {
    const campaign = await Campaign.findByPk(campaignId);
    if (!campaign) throw new NotFoundError('Campaign not found.');
    try
    {
      await assertClientOwnership(campaign.clientId, managerId, { requireActive: false });
    } catch (err)
    {
      if (err instanceof NotFoundError) throw new NotFoundError('Campaign not found.');
      throw err;
    }
    if (campaign.type !== CAMPAIGN_TYPE.CALL)
    {
      throw new BusinessRuleError('This is not a call campaign.');
    }
    return campaign;
  }

  /**
 * Pass on a lead without a call happening at all — the gap between the
 * two real choices logRemark forces today: fabricate an outcome (e.g.
 * "Not Answered" for a call that was never dialed, which pollutes
 * calls-logged stats and call history with a phantom attempt), or get
 * stuck re-seeing the same card forever since /next has no side effect
 * of its own to advance past it.
 *
 * Deliberately writes NO call_remarks row — no conversation happened, so
 * nothing should look like one did. queueStatus is left exactly as it
 * was; the only effect is stamping last_skipped_at, which getNextLead's
 * ordering treats exactly like a genuine attempt (GREATEST against the
 * call_remarks-derived signal) — so the lead drops to the back of this
 * executive's queue and is re-served once everything else has had a turn,
 * the same as if it had actually been worked.
 */
  async skipLead(campaignLeadId, executiveUserId)
  {
    const { campaignLead, campaign } = await this._assertExecutiveOnCampaignLead(campaignLeadId, executiveUserId);

    if (campaign.status !== CAMPAIGN_STATUS.ACTIVE)
    {
      throw new BusinessRuleError(`This campaign is ${campaign.status} — leads cannot be skipped.`);
    }
    if ([QUEUE_STATUS.COMPLETED, QUEUE_STATUS.SKIPPED].includes(campaignLead.queueStatus))
    {
      throw new BusinessRuleError('This lead has already been resolved in this campaign.');
    }

    await campaignLead.update({ lastSkippedAt: new Date() });

    return { campaignLeadId, queueStatus: campaignLead.queueStatus, skippedAt: campaignLead.lastSkippedAt };
  }

  /**
   * Full detail for ONE specific lead, by id — the missing piece for
   * acting on a callbacks-due entry directly. That list already returns
   * each row's campaignLeadId, but only a reduced summary (no
   * previousRemarks, no jobTitle/industry/email) — exactly the context an
   * Executive would actually want before calling someone back about a
   * promise made on an earlier call. Reuses the SAME toCallCard shape
   * /next returns, so a frontend renders both identically.
   *
   * Deliberately read-only: no live consent re-check, no side effects at
   * all. That check exists specifically to gate SERVING a lead through
   * the queue — looking up detail on a lead you already know about should
   * never itself retire it.
   */
  async getLeadDetail(campaignLeadId, executiveUserId)
  {
    const { campaignLead } = await this._assertExecutiveOnCampaignLead(campaignLeadId, executiveUserId);

    const lead = await Lead.findByPk(campaignLead.leadId);
    const previousRemarks = await CallRemark.findAll({
      where: { campaignLeadId: campaignLead.id },
      order: [['createdAt', 'DESC']]
    });

    return toCallCard(campaignLead, lead, previousRemarks);
  }
}

module.exports = new CallService();
