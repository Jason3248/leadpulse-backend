'use strict';

/**
 * leadpulse-email-service
 *
 * A small, standalone microservice with one job: accept a send request and
 * dispatch it. Right now there's no SendGrid account wired up, so it logs
 * the "would send" event instead of actually delivering — but the point of
 * isolating this into its own service is that swapping the stub for a real
 * SendGrid/Nodemailer call later is a change entirely inside this one
 * file. The main API, and everything calling it, never needs to know or
 * change when that happens.
 */

require('dotenv').config({ path: require('path').resolve(__dirname, '..', '..', '.env') });

const express = require('express');
const winston = require('winston');
const { serviceAuth } = require('leadpulse-data-model');

const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(winston.format.timestamp(), winston.format.simple()),
  transports: [new winston.transports.Console()]
});

const app = express();
app.use(express.json());

// Unauthenticated by design, same as the other services — health probes
// need to reach it and it exposes nothing sensitive.
app.get('/health', (req, res) =>
{
  res.status(200).json({ status: 'ok', service: 'email' });
});

// Everything past this point requires the shared service token.
app.use(serviceAuth.requireServiceAuth);

app.post('/send', async (req, res) =>
{
  const { to, subject, html, text, senderName, replyTo, token } = req.body || {};

  if (!to || !subject || (!html && !text))
  {
    return res.status(400).json({
      success: false,
      code: 'VALIDATION_ERROR',
      message: 'to, subject, and (html or text) are required.'
    });
  }

  // Real delivery only when SendGrid is configured. Without an API key the
  // service stays in stub mode and logs instead — so the whole flow is
  // testable end to end before any account exists, and switching to real
  // sending is purely an environment change, never a code change.
  if (!process.env.SENDGRID_API_KEY)
  {
    // html/text are logged deliberately: with no real provider wired up,
    // this log is the ONLY way to retrieve what would have been sent (a
    // password-reset link, for instance). Dropping them silently breaks
    // every local flow that depends on reading the mail back.
    logger.info('Email dispatched (stub — no SENDGRID_API_KEY set)', { to, subject, html, text, token });
    return res.status(200).json({ success: true, data: { queued: true, stubbed: true } });
  }

  try
  {
    const sgMail = require('@sendgrid/mail');
    sgMail.setApiKey(process.env.SENDGRID_API_KEY);

    await sgMail.send({
      to,
      from: {
        email: process.env.SENDGRID_FROM_EMAIL,
        name: senderName || process.env.SENDGRID_FROM_NAME || 'LeadPulse'
      },
      ...(replyTo ? { replyTo } : {}),
      subject,
      ...(html ? { html } : {}),
      ...(text ? { text } : {}),
      ...(token ? { customArgs: { token } } : {})
    });

    logger.info('Email sent via SendGrid', { to, subject });
    return res.status(200).json({ success: true, data: { queued: true, stubbed: false } });
  } catch (err)
  {
    // Reported back rather than thrown: the dispatch loop records this
    // against the individual recipient and carries on with the rest of
    // the batch, per SRS 4.5.2.
    const detail = err.response && err.response.body ? JSON.stringify(err.response.body) : err.message;
    logger.warn('SendGrid send failed', { to, detail });
    return res.status(502).json({
      success: false,
      code: 'SEND_FAILED',
      message: 'The email provider rejected this message.',
      detail
    });
  }
});

app.use((req, res) =>
{
  res.status(404).json({ success: false, code: 'NOT_FOUND', message: 'Unknown route.' });
});

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) =>
{
  logger.error('Unhandled error', { message: err.message, stack: err.stack });
  res.status(500).json({ success: false, code: 'INTERNAL_SERVER_ERROR', message: 'Something went wrong.' });
});

const PORT = process.env.EMAIL_SERVICE_PORT || 4002;
app.listen(PORT, () =>
{
  logger.info(`leadpulse-email-service listening on port ${PORT}`);
});
