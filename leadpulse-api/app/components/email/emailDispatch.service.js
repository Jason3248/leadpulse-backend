'use strict';

const crypto = require('crypto');
const {
  Campaign,
  CampaignExecutive,
  CampaignLead,
  EmailDispatchJob,
  Lead,
  LeadEngagement,
  User,
  sequelize,
  Sequelize,
  constants
} = require('leadpulse-data-model');
const { NotFoundError, BusinessRuleError, ForbiddenError } = require('../../lib');
const { checkContactable, updateLeadStatus } = require('../lead/leadStatus.service.js');
const assertClientOwnership = require('../client/assertClientOwnership.js');
const { sendEmail } = require('../../utils/emailServiceClient.js');
const { buildEmailHtml, buildSubject } = require('./emailRenderer.js');
const notifications = require('../notification/notification.service.js');
const logger = require('../../configs/logger.js');

const { Op } = Sequelize;
const { CAMPAIGN_STATUS, CAMPAIGN_TYPE, DISPATCH_STATUS, MEMBERSHIP_STATUS, ROLES } = constants;

const BATCH_SIZE = 50; // SRS 4.5.2
const BATCH_DELAY_MS = 200; // SRS 4.5.2
const STALE_PROCESSING_MS = 30 * 60 * 1000;

const toPublicJob = (job) => ({
  id: job.id,
  campaignId: job.campaignId,
  status: job.status,
  totalRecipients: job.totalRecipients,
  processed: job.processed,
  sent: job.sent,
  failed: job.failed,
  suppressed: job.suppressed,
  progressPercentage: job.progressPercentage(),
  failureReason: job.failureReason,
  startedAt: job.startedAt,
  finishedAt: job.finishedAt,
  createdAt: job.createdAt
});

class EmailDispatchService
{
  /**
   * Trigger a dispatch. Returns 202-style immediately: the actual sending
   * runs detached, and the caller polls the returned job for progress.
   *
   * Both a Manager and an assigned Executive may trigger this (SRS 4.5.2) —
   * assignment grants dispatch rights, but never bypasses approval.
   */
  async startDispatch(campaignId, user)
  {
    const campaign = await this._assertCanDispatch(campaignId, user);

    if (campaign.status !== CAMPAIGN_STATUS.ACTIVE)
    {
      throw new BusinessRuleError(`This campaign is ${campaign.status} — it cannot be dispatched.`);
    }

    // The double-send guard: a single conditional UPDATE that only succeeds
    // if dispatch_status is still not_sent. Two concurrent clicks (or a
    // Manager and an Executive at the same moment) race here, and exactly
    // one wins — a read-then-write check would leave a window where both
    // pass before either writes.
    const [affectedRows] = await Campaign.update(
      { dispatchStatus: DISPATCH_STATUS.SENDING },
      { where: { id: campaignId, dispatchStatus: DISPATCH_STATUS.NOT_SENT } }
    );
    if (affectedRows === 0)
    {
      const current = await Campaign.findByPk(campaignId);
      throw new BusinessRuleError(
        current.dispatchStatus === DISPATCH_STATUS.SENDING
          ? 'This campaign is already being dispatched.'
          : 'This campaign has already been dispatched.'
      );
    }

    const totalRecipients = await CampaignLead.count({ where: { campaignId } });

    const job = await EmailDispatchJob.create({
      campaignId,
      startedByUserId: user.id,
      status: 'queued',
      totalRecipients
    });

    // SRS 4.10: confirm the launch to the campaign's owning manager. Sent
    // to the manager who owns the client, not necessarily the person who
    // clicked — an executive may have triggered it.
    const owningManager = await User.findByPk(campaign.createdByUserId);
    if (owningManager) await notifications.campaignLaunched(owningManager, campaign, totalRecipients);

    // Detached on purpose — the HTTP response must not wait for the send.
    this._runDispatch(job.id).catch((err) =>
    {
      logger.error('Email dispatch crashed', { jobId: job.id, message: err.message, stack: err.stack });
    });

    return toPublicJob(job);
  }

  /** The actual send loop. Runs outside the request lifecycle. */
  async _runDispatch(jobId)
  {
    const job = await EmailDispatchJob.findByPk(jobId);
    if (!job) return;

    const campaign = await Campaign.findByPk(job.campaignId);
    await job.update({ status: 'processing', startedAt: new Date() });

    const trackingBaseUrl = process.env.TRACKING_BASE_URL || 'http://localhost:4000/api/v1';
    let sent = 0;
    let failed = 0;
    let suppressed = 0;
    let processed = 0;

    try
    {
      const campaignLeads = await CampaignLead.findAll({
        where: { campaignId: campaign.id },
        include: [{ model: Lead, as: 'lead' }],
        order: [['addedAt', 'ASC']]
      });

      for (let i = 0; i < campaignLeads.length; i += BATCH_SIZE)
      {
        const batch = campaignLeads.slice(i, i + BATCH_SIZE);

        for (const cl of batch)
        {
          processed += 1;

          // The live consent re-check, per recipient, at the moment of
          // sending — never trusted from the frozen audience. Someone who
          // unsubscribed or was marked DNC after approval is skipped here,
          // and counted as suppressed so the totals still reconcile.
          const { contactable, reason } = await checkContactable({
            clientId: campaign.clientId,
            leadListId: campaign.leadListId,
            leadId: cl.leadId,
            channel: CAMPAIGN_TYPE.EMAIL,
            excludeClosedLeads: campaign.excludeClosedLeads
          });

          if (!contactable)
          {
            suppressed += 1;
            logger.info('Suppressed email recipient', { campaignId: campaign.id, leadId: cl.leadId, reason });
            continue;
          }

          const token = crypto.randomBytes(24).toString('hex');

          try
          {
            // sentAt is stamped only once the provider accepts the message
            // (below), never at creation — it's the single marker that
            // distinguishes "actually sent" from "attempted and rejected",
            // and analytics depends on that distinction being honest.
            const engagement = await LeadEngagement.create({
              campaignLeadId: cl.id,
              trackingToken: token,
              status: constants.ENGAGEMENT_STATUS.SENT
            });

            const html = buildEmailHtml({ campaign, lead: cl.lead, token, trackingBaseUrl });
            const subject = buildSubject(campaign, cl.lead);

            const result = await sendEmail({
              to: cl.lead.email,
              subject,
              html,
              senderName: campaign.senderName,
              replyTo: campaign.replyToEmail,
              token
            });

            if (result && result.ok === false)
            {
              // A per-recipient failure never aborts the run (SRS 4.5.2) —
              // it's recorded against that recipient and the batch continues.
              failed += 1;
              await engagement.update({ errorMessage: result.message || 'Send failed' });
            } else
            {
              sent += 1;
              await engagement.update({ sentAt: new Date() });
              await updateLeadStatus({
                leadListId: campaign.leadListId,
                leadId: cl.leadId,
                newStatus: MEMBERSHIP_STATUS.CONTACTED,
                isManualOverride: false
              });
            }
          } catch (err)
          {
            failed += 1;
            logger.warn('Failed to send to recipient', { leadId: cl.leadId, message: err.message });
          }
        }

        await job.update({ processed, sent, failed, suppressed });
        if (i + BATCH_SIZE < campaignLeads.length)
        {
          await new Promise((r) => setTimeout(r, BATCH_DELAY_MS));
        }
      }

      await job.update({
        status: failed > 0 ? 'completed_with_errors' : 'completed',
        processed,
        sent,
        failed,
        suppressed,
        finishedAt: new Date()
      });
      await campaign.update({ dispatchStatus: DISPATCH_STATUS.SENT });
      logger.info('Email dispatch finished', { jobId, sent, failed, suppressed });
      await this._notifyCompletion(campaign, { sent, failed, suppressed });
    } catch (err)
    {
      logger.error('Email dispatch failed', { jobId, message: err.message });
      await job.update({
        status: 'failed',
        failureReason: 'Dispatch stopped unexpectedly. Please review the campaign and retry.',
        processed,
        sent,
        failed,
        suppressed,
        finishedAt: new Date()
      });
      // Released back to not_sent so a failed run can genuinely be retried —
      // leaving it stuck on "sending" would permanently block the campaign.
      await campaign.update({ dispatchStatus: DISPATCH_STATUS.NOT_SENT });
    }
  }

  /**
   * Completion summary plus the SRS 4.10 threshold alerts.
   *
   * Bounce and unsubscribe rates are evaluated here, immediately after the
   * run, rather than on demand: a manager needs to hear about a
   * deliverability problem without having to go looking for it. The
   * campaign's alert flags make each one fire at most once.
   */
  async _notifyCompletion(campaign, stats)
  {
    const manager = await User.findByPk(campaign.createdByUserId);
    if (!manager) return;

    await notifications.emailCampaignCompleted(manager, campaign, stats);

    if (stats.sent === 0) return;

    const campaignLeadIds = (
      await CampaignLead.findAll({ where: { campaignId: campaign.id }, attributes: ['id'] })
    ).map((cl) => cl.id);
    if (!campaignLeadIds.length) return;

    const [bounced, unsubscribed] = await Promise.all([
      LeadEngagement.count({ where: { campaignLeadId: { [Op.in]: campaignLeadIds }, status: 'bounced' } }),
      LeadEngagement.count({
        where: { campaignLeadId: { [Op.in]: campaignLeadIds }, unsubscribedAt: { [Op.ne]: null } }
      })
    ]);

    const bounceRate = Number(((bounced / stats.sent) * 100).toFixed(2));
    const unsubRate = Number(((unsubscribed / stats.sent) * 100).toFixed(2));

    // No extra guard needed: this runs once per completed dispatch, and a
    // campaign can only be dispatched once (the dispatch_status lock), so
    // each alert can fire at most once per campaign by construction.
    if (bounceRate > 10)
    {
      await notifications.highBounceRateAlert(manager, campaign, bounceRate);
    }
    if (unsubRate > 5)
    {
      await notifications.highUnsubscribeRateAlert(manager, campaign, unsubRate);
    }
  }

  async getStatus(jobId, user)
  {
    const job = await EmailDispatchJob.findByPk(jobId);
    if (!job) throw new NotFoundError('Dispatch job not found.');
    await this._assertCanDispatch(job.campaignId, user, { requireActive: false });
    await this._failIfStale(job);
    return toPublicJob(job);
  }

  async listForCampaign(campaignId, user)
  {
    await this._assertCanDispatch(campaignId, user, { requireActive: false });
    const jobs = await EmailDispatchJob.findAll({ where: { campaignId }, order: [['createdAt', 'DESC']], limit: 20 });
    await Promise.all(jobs.map((j) => this._failIfStale(j)));
    return jobs.map(toPublicJob);
  }

  /**
   * Same lazy rescue as import jobs: if the process dies mid-dispatch (an
   * ECS task restart, say), nothing else would ever move the job off
   * "processing", so a poller would wait forever. Also releases the
   * campaign's dispatch lock so it isn't permanently stuck on "sending".
   */
  async _failIfStale(job)
  {
    if (job.status !== 'processing' || !job.startedAt) return;
    if (Date.now() - new Date(job.startedAt).getTime() < STALE_PROCESSING_MS) return;

    logger.warn('Marking a stalled email dispatch as failed', { jobId: job.id });
    await job.update({
      status: 'failed',
      failureReason: 'Dispatch stopped unexpectedly and did not finish. Please retry.',
      finishedAt: new Date()
    });
    await Campaign.update(
      { dispatchStatus: DISPATCH_STATUS.NOT_SENT },
      { where: { id: job.campaignId, dispatchStatus: DISPATCH_STATUS.SENDING } }
    );
  }

  async _assertCanDispatch(campaignId, user, { requireActive = true } = {})
  {
    const campaign = await Campaign.findByPk(campaignId);
    if (!campaign) throw new NotFoundError('Campaign not found.');
    if (campaign.type !== CAMPAIGN_TYPE.EMAIL)
    {
      throw new BusinessRuleError('This is not an email campaign.');
    }

    if (user.role === ROLES.CAMPAIGN_MANAGER)
    {
      try
      {
        await assertClientOwnership(campaign.clientId, user.id, { requireActive });
      } catch (err)
      {
        if (err instanceof NotFoundError) throw new NotFoundError('Campaign not found.');
        throw err;
      }
      return campaign;
    }

    if (user.role === ROLES.EXECUTIVE)
    {
      const assignment = await CampaignExecutive.findOne({
        where: { campaignId, executiveUserId: user.id, isActive: true }
      });
      if (!assignment) throw new NotFoundError('Campaign not found.');
      return campaign;
    }

    throw new ForbiddenError('You do not have permission to dispatch campaigns.');
  }
}

module.exports = new EmailDispatchService();
