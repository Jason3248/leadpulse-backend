'use strict';

const { sendEmail } = require('../../utils/emailServiceClient.js');
const logger = require('../../configs/logger.js');

/**
 * Every transactional notification from SRS 4.10, in one place rather than
 * scattered across the services that trigger them.
 *
 * Two deliberate properties:
 *
 *  - Nothing here throws. A notification is a side-effect of a business
 *    action, never the point of it: if the mail service is down, creating
 *    an executive must still succeed. Failures are logged loudly instead.
 *  - These go through the same email microservice as campaign mail, so a
 *    single SENDGRID_API_KEY switch moves transactional mail to real
 *    delivery too — no separate path to configure or forget about.
 */

const APP_URL = () => process.env.APP_URL || 'http://localhost:3000';

const wrap = (heading, bodyHtml) => `
  <div style="font-family:sans-serif;max-width:600px;">
    <h2 style="color:#1a56db;">${heading}</h2>
    ${bodyHtml}
    <hr style="margin-top:24px;border:none;border-top:1px solid #eee;" />
    <p style="font-size:12px;color:#888;">Sent by LeadPulse.</p>
  </div>`;

const escape = (v) =>
  String(v == null ? '' : v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

async function safeSend(label, payload) {
  try {
    const result = await sendEmail(payload);
    if (result && result.ok === false) {
      logger.warn(`Notification not delivered: ${label}`, { to: payload.to, message: result.message });
    }
  } catch (err) {
    logger.warn(`Notification threw: ${label}`, { to: payload.to, error: err.message });
  }
}

const notifications = {
  /** 4.10: a new Campaign Manager self-registers. */
  async managerWelcome(user) {
    await safeSend('managerWelcome', {
      to: user.email,
      subject: 'Welcome to LeadPulse',
      html: wrap(
        `Welcome, ${escape(user.firstName)}`,
        `<p>Your Campaign Manager account is ready.</p>
         <p>To get started: add a client, upload a lead list for them, then create your
         first campaign.</p>
         <p><a href="${APP_URL()}/login">Sign in to LeadPulse</a></p>`
      )
    });
  },

  /**
   * 4.10 / 4.2.1: an Executive is created by a Manager. Carries the
   * temporary password — the only time it is ever transmitted, since only
   * its hash is stored.
   */
  async executiveCredentials(user, temporaryPassword) {
    await safeSend('executiveCredentials', {
      to: user.email,
      subject: 'Your LeadPulse account is ready',
      html: wrap(
        `Hello ${escape(user.firstName)}`,
        `<p>An account has been created for you on LeadPulse.</p>
         <p><strong>Email:</strong> ${escape(user.email)}<br/>
            <strong>Temporary password:</strong> ${escape(temporaryPassword)}</p>
         <p style="color:#b91c1c;"><strong>Please change this password after your first
         sign-in.</strong></p>
         <p><a href="${APP_URL()}/login">Sign in to LeadPulse</a></p>`
      )
    });
  },

  /** 4.11: a Client portal user is created by a Manager. */
  async clientPortalCredentials(user, clientName, temporaryPassword) {
    await safeSend('clientPortalCredentials', {
      to: user.email,
      subject: `Your ${clientName} campaign portal is ready`,
      html: wrap(
        `Hello ${escape(user.firstName)}`,
        `<p>You now have read-only access to the campaign portal for
         <strong>${escape(clientName)}</strong>, where you can follow campaign progress
         and download reports.</p>
         <p><strong>Email:</strong> ${escape(user.email)}<br/>
            <strong>Temporary password:</strong> ${escape(temporaryPassword)}</p>
         <p style="color:#b91c1c;"><strong>Please change this password after your first
         sign-in.</strong></p>
         <p><a href="${APP_URL()}/login">Sign in to the portal</a></p>`
      )
    });
  },

  /** 4.10: an Executive is assigned to a campaign. */
  async executiveAssigned(user, campaign, clientName) {
    await safeSend('executiveAssigned', {
      to: user.email,
      subject: `You've been assigned to "${campaign.name}"`,
      html: wrap(
        'New campaign assignment',
        `<p>Hello ${escape(user.firstName)}, you've been assigned to a campaign.</p>
         <p><strong>Campaign:</strong> ${escape(campaign.name)}<br/>
            <strong>Type:</strong> ${escape(campaign.type)}<br/>
            <strong>Client:</strong> ${escape(clientName)}</p>
         <p><a href="${APP_URL()}/dashboard">Open your dashboard</a></p>`
      )
    });
  },

  /** 4.10: an email campaign has been launched. */
  async campaignLaunched(manager, campaign, audienceCount) {
    await safeSend('campaignLaunched', {
      to: manager.email,
      subject: `"${campaign.name}" is sending`,
      html: wrap(
        'Campaign launched',
        `<p><strong>${escape(campaign.name)}</strong> is now dispatching to
         <strong>${audienceCount}</strong> recipients.</p>
         <p>You'll get a summary once it finishes.</p>`
      )
    });
  },

  /** 4.10: an email campaign finished sending. */
  async emailCampaignCompleted(manager, campaign, stats) {
    await safeSend('emailCampaignCompleted', {
      to: manager.email,
      subject: `"${campaign.name}" has finished sending`,
      html: wrap(
        'Campaign complete',
        `<p><strong>${escape(campaign.name)}</strong> has finished.</p>
         <ul>
           <li>Sent: ${stats.sent}</li>
           <li>Suppressed (opted out or undeliverable): ${stats.suppressed}</li>
           <li>Failed: ${stats.failed}</li>
         </ul>
         <p><a href="${APP_URL()}/campaigns/${campaign.id}">View full analytics</a></p>`
      )
    });
  },

  /** 4.10: a call campaign reached the end of its queue. */
  async callCampaignCompleted(manager, campaign, stats) {
    await safeSend('callCampaignCompleted', {
      to: manager.email,
      subject: `"${campaign.name}" has been completed`,
      html: wrap(
        'Call campaign complete',
        `<p><strong>${escape(campaign.name)}</strong> has finished.</p>
         <ul>
           <li>Calls logged: ${stats.callsLogged}</li>
           <li>Confirmed conversions: ${stats.confirmedConversions}</li>
         </ul>
         <p><a href="${APP_URL()}/campaigns/${campaign.id}">View full report</a></p>`
      )
    });
  },

  /** 4.10: bounce rate above 10% — a deliverability risk, not just a stat. */
  async highBounceRateAlert(manager, campaign, bounceRate) {
    await safeSend('highBounceRateAlert', {
      to: manager.email,
      subject: `High bounce rate on "${campaign.name}"`,
      html: wrap(
        'Deliverability warning',
        `<p><strong>${escape(campaign.name)}</strong> has a bounce rate of
         <strong>${bounceRate}%</strong>, above the 10% threshold.</p>
         <p>A sustained high bounce rate can damage your sending domain's reputation and
         affect deliverability for every client. This usually points to a stale or
         poorly-sourced lead list.</p>`
      )
    });
  },

  /** 4.10: unsubscribe rate above 5%. */
  async highUnsubscribeRateAlert(manager, campaign, unsubscribeRate) {
    await safeSend('highUnsubscribeRateAlert', {
      to: manager.email,
      subject: `High unsubscribe rate on "${campaign.name}"`,
      html: wrap(
        'Engagement warning',
        `<p><strong>${escape(campaign.name)}</strong> has an unsubscribe rate of
         <strong>${unsubscribeRate}%</strong>, above the 5% threshold.</p>
         <p>This often signals a targeting or messaging mismatch — the audience may not
         be a good fit for this campaign.</p>`
      )
    });
  }
};

module.exports = notifications;
