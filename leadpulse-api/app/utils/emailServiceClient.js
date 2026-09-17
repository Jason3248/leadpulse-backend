'use strict';

const logger = require('../configs/logger.js');
const { serviceAuth } = require('leadpulse-data-model');

const EMAIL_SERVICE_URL = process.env.EMAIL_SERVICE_URL || 'http://localhost:4002';

/**
 * Sends one email via leadpulse-email-service.
 *
 * Returns { ok, message } rather than throwing: a single recipient failing
 * must never abort a campaign dispatch of hundreds (SRS 4.5.2). The caller
 * records the failure against that recipient and continues the batch.
 */
async function sendEmail({ to, subject, html, text, senderName, replyTo, token })
{
  try
  {
    const response = await fetch(`${EMAIL_SERVICE_URL}/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...serviceAuth.serviceAuthHeaders() },
      body: JSON.stringify({ to, subject, html, text, senderName, replyTo, token })
    });

    if (!response.ok)
    {
      const body = await response.json().catch(() => ({}));
      logger.warn('Email service returned an error', { to, subject, message: body.message });
      return { ok: false, message: body.message || `Email service responded ${response.status}` };
    }
    return { ok: true };
  } catch (err)
  {
    logger.warn('Email service unreachable', { to, subject, error: err.message });
    return { ok: false, message: 'The email service is currently unreachable.' };
  }
}

module.exports = { sendEmail };
