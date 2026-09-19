'use strict';

const {
  Campaign,
  CampaignExecutive,
  CampaignLead,
  Client,
  LeadList,
  User,
  Sequence,
  sequelize,
  Sequelize,
  constants
} = require('leadpulse-data-model');
const { NotFoundError, BusinessRuleError, ValidationError, ConflictError } = require('../../lib');
const assertClientOwnership = require('../client/assertClientOwnership.js');
const { resolveAudienceLeadIds } = require('./audience.service.js');
const notifications = require('../notification/notification.service.js');
const logger = require('../../configs/logger.js');

const { Op } = Sequelize;
const { CAMPAIGN_STATUS, CAMPAIGN_TYPE, QUEUE_STATUS, ROLES } = constants;

const CLOSED_MEMBERSHIP_STATUSES = ['Converted', 'Dead'];

const toPublicCampaign = (c) => ({
  id: c.id,
  clientId: c.clientId,
  leadListId: c.leadListId,
  sequenceId: c.sequenceId,
  sequenceStepOrder: c.sequenceStepOrder,
  name: c.name,
  type: c.type,
  description: c.description,
  categoryTag: c.categoryTag,
  status: c.status,
  dispatchStatus: c.dispatchStatus,
  segmentationFilters: c.segmentationFilters,
  excludeClosedLeads: c.excludeClosedLeads,
  pricingModel: c.pricingModel,
  retainerAmount: c.retainerAmount,
  ratePerLead: c.ratePerLead,
  requiresManagerApproval: c.requiresManagerApproval,
  approvedAt: c.approvedAt,
  subjectLine: c.subjectLine,
  senderName: c.senderName,
  replyToEmail: c.replyToEmail,
  emailBodyHtml: c.emailBodyHtml,
  bannerImageUrl: c.bannerImageUrl,
  createdAt: c.createdAt
});

class CampaignService
{
  async create(data, managerId)
  {
    await assertClientOwnership(data.clientId, managerId, { requireActive: true });

    // The source list must belong to this client, and must not be archived —
    // archiving means "retired, don't run anything new against this".
    const list = await LeadList.findOne({ where: { id: data.leadListId, clientId: data.clientId } });
    if (!list) throw new NotFoundError('Lead list not found for this client.');
    if (list.status === constants.LEAD_LIST_STATUS.ARCHIVED)
    {
      throw new BusinessRuleError('That lead list is archived and cannot be used for a new campaign.');
    }

    this._assertTargetingIsCoherent(data);

    // If linked to a sequence, that sequence must belong to the same client.
    if (data.sequenceId)
    {
      const seq = await Sequence.findOne({ where: { id: data.sequenceId, clientId: data.clientId } });
      if (!seq) throw new NotFoundError('Sequence not found for this client.');
      if (seq.leadListId && seq.leadListId !== data.leadListId)
      {
        throw new BusinessRuleError('A campaign linked to a sequence must target the same lead list as the sequence.');
      }
      if (data.sequenceStepOrder !== undefined && data.sequenceStepOrder !== null)
      {
        const existingStep = await Campaign.findOne({
          where: { sequenceId: data.sequenceId, sequenceStepOrder: data.sequenceStepOrder }
        });
        if (existingStep)
        {
          throw new ConflictError('Another campaign in this sequence already uses this step order.');
        }
      }
    }

    const campaign = await Campaign.create({
      clientId: data.clientId,
      leadListId: data.leadListId,
      sequenceId: data.sequenceId || null,
      sequenceStepOrder: data.sequenceStepOrder || null,
      createdByUserId: managerId,
      name: data.name,
      type: data.type,
      description: data.description || null,
      categoryTag: data.categoryTag || null,
      segmentationFilters: data.segmentationFilters || null,
      excludeClosedLeads: data.excludeClosedLeads ?? true,
      pricingModel: data.pricingModel || null,
      retainerAmount: data.retainerAmount ?? null,
      ratePerLead: data.ratePerLead ?? null,
      requiresManagerApproval: data.requiresManagerApproval ?? true,
      subjectLine: data.subjectLine || null,
      senderName: data.senderName || null,
      replyToEmail: data.replyToEmail || null,
      emailBodyHtml: data.emailBodyHtml || null,
      bannerImageUrl: data.bannerImageUrl || null
    });

    return toPublicCampaign(campaign);
  }

  /**
   * Edit a campaign. Only allowed while it's still a draft: once approved,
   * the audience is frozen, and letting the segmentation or source list
   * change afterwards would leave the frozen campaign_leads rows describing
   * something the campaign no longer claims to target.
   */
  async update(id, managerId, updates)
  {
    const campaign = await this._getOwnedCampaign(id, managerId, { requireActive: true });

    if (campaign.status !== CAMPAIGN_STATUS.DRAFT)
    {
      throw new BusinessRuleError('Only a draft campaign can be edited. Its audience is frozen once approved.');
    }

    // Pricing and targeting must stay coherent after the merge, not just in
    // isolation — a partial update could otherwise create a contradiction
    // that neither the old nor the new values had on their own.
    const merged = {
      pricingModel: updates.pricingModel !== undefined ? updates.pricingModel : campaign.pricingModel,
      retainerAmount: updates.retainerAmount !== undefined ? updates.retainerAmount : campaign.retainerAmount,
      ratePerLead: updates.ratePerLead !== undefined ? updates.ratePerLead : campaign.ratePerLead,
      excludeClosedLeads:
        updates.excludeClosedLeads !== undefined ? updates.excludeClosedLeads : campaign.excludeClosedLeads,
      segmentationFilters:
        updates.segmentationFilters !== undefined ? updates.segmentationFilters : campaign.segmentationFilters
    };
    this._assertPricingIsCoherent(merged);
    this._assertTargetingIsCoherent(merged);

    // Changing the source list is allowed while draft, but it must still
    // belong to this client and not be archived.
    if (updates.leadListId && updates.leadListId !== campaign.leadListId)
    {
      const list = await LeadList.findOne({ where: { id: updates.leadListId, clientId: campaign.clientId } });
      if (!list) throw new NotFoundError('Lead list not found for this client.');
      if (list.status === constants.LEAD_LIST_STATUS.ARCHIVED)
      {
        throw new BusinessRuleError('That lead list is archived and cannot be used.');
      }
      if (campaign.sequenceId)
      {
        const seq = await Sequence.findByPk(campaign.sequenceId);
        if (seq && seq.leadListId && seq.leadListId !== updates.leadListId)
        {
          throw new BusinessRuleError('A campaign linked to a sequence must target the same lead list as the sequence.');
        }
      }
    }

    if (updates.sequenceStepOrder !== undefined && updates.sequenceStepOrder !== null)
    {
      const seqId = campaign.sequenceId || updates.sequenceId;
      if (seqId)
      {
        const existingStep = await Campaign.findOne({
          where: { sequenceId: seqId, sequenceStepOrder: updates.sequenceStepOrder }
        });
        if (existingStep && existingStep.id !== campaign.id)
        {
          throw new ConflictError('Another campaign in this sequence already uses this step order.');
        }
      }
    }

    logger.info("updates: ", updates);
    await campaign.update(updates);
    return this.getById(id, managerId);
  }

  // excludeClosedLeads and a Converted/Dead membershipStatus filter directly
  // contradict each other. Rather than silently resolving it one way, make
  // the manager state their intent: a re-engagement campaign must explicitly
  // set excludeClosedLeads to false.
  _assertTargetingIsCoherent({ segmentationFilters, excludeClosedLeads })
  {
    const status = segmentationFilters && segmentationFilters.membershipStatus;
    const excluding = excludeClosedLeads ?? true;
    if (status && CLOSED_MEMBERSHIP_STATUSES.includes(status) && excluding)
    {
      throw new BusinessRuleError(
        `Targeting ${status} leads requires excludeClosedLeads to be false (a deliberate re-engagement campaign).`
      );
    }
  }

  _assertPricingIsCoherent({ pricingModel, retainerAmount, ratePerLead })
  {
    if (pricingModel === 'flat_retainer' && (retainerAmount == null || ratePerLead != null))
    {
      throw new BusinessRuleError('A flat retainer campaign needs retainerAmount and no ratePerLead.');
    }
    if (pricingModel === 'cost_per_lead' && (ratePerLead == null || retainerAmount != null))
    {
      throw new BusinessRuleError('A cost-per-lead campaign needs ratePerLead and no retainerAmount.');
    }
    if (!pricingModel && (retainerAmount != null || ratePerLead != null))
    {
      throw new BusinessRuleError('Pricing amounts require a pricing model.');
    }
  }

  async list({ managerId, clientId, status, type })
  {
    // Scope to campaigns whose client this manager owns.
    const clientWhere = { managerId };
    if (clientId) clientWhere.id = clientId;
    const ownedClientIds = (await Client.findAll({ where: clientWhere, attributes: ['id'] })).map((c) => c.id);
    if (ownedClientIds.length === 0) return [];

    const where = { clientId: { [Op.in]: ownedClientIds } };
    if (status) where.status = status;
    if (type) where.type = type;

    const campaigns = await Campaign.findAll({ where, order: [['createdAt', 'DESC']] });
    return campaigns.map(toPublicCampaign);
  }

  async getById(id, managerId)
  {
    const campaign = await this._getOwnedCampaign(id, managerId);

    const executives = await CampaignExecutive.findAll({
      where: { campaignId: id, isActive: true },
      include: [{ model: User, as: 'executive', attributes: ['id', 'firstName', 'lastName', 'email'] }]
    });

    const audienceCount = await CampaignLead.count({ where: { campaignId: id } });

    return {
      ...toPublicCampaign(campaign),
      executives: executives.map((e) => ({
        id: e.executive.id,
        firstName: e.executive.firstName,
        lastName: e.executive.lastName,
        email: e.executive.email
      })),
      audienceCount
    };
  }

  async assignExecutives(id, managerId, executiveUserIds)
  {
    const campaign = await this._getOwnedCampaign(id, managerId, { requireActive: true });

    // Executives must be real executives created by this manager.
    const executives = await User.findAll({
      where: { id: { [Op.in]: executiveUserIds }, role: ROLES.EXECUTIVE, managerId }
    });
    if (executives.length !== executiveUserIds.length)
    {
      throw new ValidationError('One or more executives are invalid or not managed by you.');
    }

    // Idempotent: skip anyone already actively assigned (the partial unique
    // index would reject a duplicate anyway, but checking first gives a
    // clean result instead of a constraint error).
    const existing = await CampaignExecutive.findAll({
      where: { campaignId: id, executiveUserId: { [Op.in]: executiveUserIds }, isActive: true },
      attributes: ['executiveUserId']
    });
    const alreadyAssigned = new Set(existing.map((e) => e.executiveUserId));
    const toAssign = executiveUserIds.filter((eid) => !alreadyAssigned.has(eid));

    await CampaignExecutive.bulkCreate(toAssign.map((eid) => ({ campaignId: id, executiveUserId: eid })));

    // SRS 4.10: tell each newly-assigned executive. Only the ones actually
    // added — re-running an assignment shouldn't re-notify people who were
    // already on the campaign.
    if (toAssign.length)
    {
      const client = await Client.findByPk(campaign.clientId);
      const notifyTargets = executives.filter((e) => toAssign.includes(e.id));
      await Promise.all(
        notifyTargets.map((e) => notifications.executiveAssigned(e, campaign, client ? client.name : ''))
      );
    }

    return this.getById(id, managerId);
  }

  async unassignExecutive(id, managerId, executiveUserId)
  {
    await this._getOwnedCampaign(id, managerId, { requireActive: true });

    const assignment = await CampaignExecutive.findOne({
      where: { campaignId: id, executiveUserId, isActive: true }
    });
    if (!assignment) throw new NotFoundError('That executive is not actively assigned to this campaign.');

    // Soft-close, preserving history — never hard delete.
    await assignment.update({ isActive: false, unassignedAt: new Date() });

    // Any leads that were assigned to this executive go back to the pool
    // (unassigned) so the manager can redistribute them. We don't
    // auto-reassign (documented, deliberate gap).
    await CampaignLead.update(
      { assignedExecutiveId: null },
      { where: { campaignId: id, assignedExecutiveId: executiveUserId } }
    );

    return this.getById(id, managerId);
  }

  async getStrandedLeads(id, managerId)
  {
    const campaign = await this._getOwnedCampaign(id, managerId, { requireActive: false });
    if (campaign.type !== CAMPAIGN_TYPE.CALL)
    {
      throw new BusinessRuleError('Only call campaigns have queue assignment.');
    }

    const stranded = await CampaignLead.findAll({
      where: {
        campaignId: id,
        assignedExecutiveId: null,
        queueStatus: QUEUE_STATUS.PENDING
      },
      include: [{ model: Lead, as: 'lead', attributes: ['id', 'firstName', 'lastName', 'company'] }]
    });

    return stranded.map(cl => ({
      leadId: cl.lead.id,
      firstName: cl.lead.firstName,
      lastName: cl.lead.lastName,
      company: cl.lead.company,
      addedAt: cl.addedAt
    }));
  }

  /**
   * Move a set of leads to a target executive on a live call campaign.
   * This is the manual-control counterpart to the automatic round-robin
   * split at approval: the split gives everyone a fair share instantly, and
   * this lets the manager deliberately hand specific leads to specific
   * executives afterward (or feed leads to an executive added mid-campaign).
   *
   * Only PENDING leads can be moved — once a lead is in_progress/called/
   * completed/skipped it has call history tied to whoever worked it, and
   * reassigning it would orphan or misattribute that work.
   */
  async reassignLeads(id, managerId, targetExecutiveId, leadIds)
  {
    const campaign = await this._getOwnedCampaign(id, managerId, { requireActive: true });

    if (campaign.type !== CAMPAIGN_TYPE.CALL)
    {
      throw new BusinessRuleError('Lead reassignment applies only to call campaigns.');
    }
    if (![CAMPAIGN_STATUS.ACTIVE, CAMPAIGN_STATUS.PAUSED].includes(campaign.status))
    {
      throw new BusinessRuleError('Leads can only be reassigned on an active or paused campaign.');
    }

    // The target must be actively assigned to this campaign — you assign the
    // executive first, then hand them leads.
    const targetAssignment = await CampaignExecutive.findOne({
      where: { campaignId: id, executiveUserId: targetExecutiveId, isActive: true }
    });
    if (!targetAssignment)
    {
      throw new ValidationError('The target executive is not actively assigned to this campaign.');
    }

    // Only pending leads belonging to this campaign are eligible.
    const eligible = await CampaignLead.findAll({
      where: { campaignId: id, leadId: { [Op.in]: leadIds }, queueStatus: QUEUE_STATUS.PENDING },
      attributes: ['leadId']
    });
    const eligibleIds = eligible.map((cl) => cl.leadId);

    if (eligibleIds.length === 0)
    {
      throw new BusinessRuleError('None of the selected leads are eligible for reassignment (they must be pending and part of this campaign).');
    }

    await CampaignLead.update(
      { assignedExecutiveId: targetExecutiveId },
      { where: { campaignId: id, leadId: { [Op.in]: eligibleIds } } }
    );

    return {
      reassigned: eligibleIds.length,
      skipped: leadIds.length - eligibleIds.length,
      targetExecutiveId
    };
  }

  /**
   * Approval is where the audience FREEZES. This is the single most
   * important operation in the lifecycle: it resolves the segmentation
   * filters once, writes the resulting leads into campaign_leads, splits
   * them across assigned executives (for call campaigns), and marks the
   * campaign approved. After this, the audience never changes on its own.
   */
  async approve(id, managerId)
  {
    const campaign = await this._getOwnedCampaign(id, managerId, { requireActive: true });

    if (campaign.status !== CAMPAIGN_STATUS.DRAFT)
    {
      throw new BusinessRuleError('Only a draft campaign can be approved.');
    }

    const activeExecs = await CampaignExecutive.findAll({
      where: { campaignId: id, isActive: true },
      attributes: ['executiveUserId']
    });
    const execIds = activeExecs.map((e) => e.executiveUserId);

    // Call campaigns need at least one executive to work the queue; email
    // campaigns can run manager-solo, so no executive is required there.
    if (campaign.type === CAMPAIGN_TYPE.CALL && execIds.length === 0)
    {
      throw new BusinessRuleError('A call campaign needs at least one assigned executive before approval.');
    }

    // Email campaigns need their core send fields present at approval time.
    if (campaign.type === CAMPAIGN_TYPE.EMAIL)
    {
      if (!campaign.subjectLine || !campaign.senderName || !campaign.emailBodyHtml)
      {
        throw new BusinessRuleError('Email campaigns need a subject line, sender name, and body before approval.');
      }
    }

    const leadIds = await resolveAudienceLeadIds(campaign);
    if (leadIds.length === 0)
    {
      throw new BusinessRuleError('This campaign\'s filters match no eligible leads — nothing to approve.');
    }

    await sequelize.transaction(async (transaction) =>
    {
      // Freeze the audience: one campaign_leads row per targeted lead.
      // For call campaigns, round-robin them across the assigned executives
      // and set queue_status pending. For email, executive/queue stay null.
      const rows = leadIds.map((leadId, index) => ({
        campaignId: id,
        leadId,
        assignedExecutiveId: campaign.type === CAMPAIGN_TYPE.CALL ? execIds[index % execIds.length] : null,
        queueStatus: campaign.type === CAMPAIGN_TYPE.CALL ? QUEUE_STATUS.PENDING : null
      }));
      await CampaignLead.bulkCreate(rows, { transaction });

      await campaign.update(
        { status: CAMPAIGN_STATUS.ACTIVE, approvedByUserId: managerId, approvedAt: new Date() },
        { transaction }
      );
    });

    return this.getById(id, managerId);
  }

  async setStatus(id, managerId, targetStatus)
  {
    // Pause/resume are always allowed while active; ending early is allowed
    // even for a deactivated client (a wind-down action), so requireActive
    // is false here and enforced per-transition below.
    const campaign = await this._getOwnedCampaign(id, managerId, { requireActive: false });

    const allowed = {
      [CAMPAIGN_STATUS.PAUSED]: [CAMPAIGN_STATUS.ACTIVE], // active -> paused
      [CAMPAIGN_STATUS.ACTIVE]: [CAMPAIGN_STATUS.PAUSED], // paused -> active (resume)
      [CAMPAIGN_STATUS.COMPLETED]: [CAMPAIGN_STATUS.ACTIVE, CAMPAIGN_STATUS.PAUSED] // end early
    };

    const validFrom = allowed[targetStatus];
    if (!validFrom || !validFrom.includes(campaign.status))
    {
      throw new BusinessRuleError(`Cannot move a ${campaign.status} campaign to ${targetStatus}.`);
    }

    // Resuming or pausing is real activity — blocked for a deactivated
    // client. Ending early is a wind-down and stays allowed.
    if (targetStatus !== CAMPAIGN_STATUS.COMPLETED)
    {
      await assertClientOwnership(campaign.clientId, managerId, { requireActive: true });
    }

    await sequelize.transaction(async (transaction) =>
    {
      await campaign.update({ status: targetStatus }, { transaction });

      // Ending a call campaign early sweeps any still-open queue rows to
      // skipped, so nothing is left dangling as "still to do". This never
      // touches the leads' own membership status — only queue bookkeeping.
      if (targetStatus === CAMPAIGN_STATUS.COMPLETED && campaign.type === CAMPAIGN_TYPE.CALL)
      {
        await CampaignLead.update(
          { queueStatus: QUEUE_STATUS.SKIPPED },
          {
            where: {
              campaignId: id,
              // CALLED is now re-servable (see call.service.js), so it's a
              // genuinely open state, not a resolved one — a straggler
              // sitting there when the campaign ends early must be swept
              // the same as pending/in_progress.
              queueStatus: { [Op.in]: [QUEUE_STATUS.PENDING, QUEUE_STATUS.IN_PROGRESS, QUEUE_STATUS.CALLED] }
            },
            transaction
          }
        );
      }
    });

    return this.getById(id, managerId);
  }

  async _getOwnedCampaign(id, managerId, { requireActive = false } = {})
  {
    const campaign = await Campaign.findByPk(id);
    if (!campaign) throw new NotFoundError('Campaign not found.');
    // Ownership flows through the client. A cross-tenant access would make
    // assertClientOwnership throw — we translate that to a campaign-level
    // not-found so the message is consistent and never confirms another
    // manager's campaign exists.
    try
    {
      await assertClientOwnership(campaign.clientId, managerId, { requireActive });
    } catch (err)
    {
      if (err instanceof NotFoundError) throw new NotFoundError('Campaign not found.');
      throw err; // ForbiddenError (deactivated client) surfaces as-is
    }
    return campaign;
  }

  async deleteDraftCampaign(id, managerId)
  {
    // 1. Fetch the campaign and ensure the manager actually owns its parent client
    const campaign = await this._getOwnedCampaign(id, managerId, { requireActive: false });

    // 2. Business Rule: Only draft campaigns can be deleted.
    if (campaign.status !== CAMPAIGN_STATUS.DRAFT)
    {
      throw new BusinessRuleError('Only draft campaigns can be deleted. Once a campaign is approved, its data is permanent.');
    }

    // 3. Destroy the campaign record. 
    // (If you have table associations with ON DELETE CASCADE, it will cleanly handle any child rows)
    await campaign.destroy();

    return { success: true, message: 'Draft campaign deleted successfully.' };
  }
}

module.exports = new CampaignService();
