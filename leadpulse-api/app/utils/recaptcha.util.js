'use strict';

const logger = require('../configs/logger.js');
const { ValidationError, UpstreamServiceError } = require('../lib');

// SRS 4.1.1 / 4.1.2 / 5.1: reCAPTCHA v3 verified server-side on
// registration, login, and password reset, with a minimum score of 0.5.
const MIN_SCORE = 0.5;

// Configurable so tests can point this at a local mock instead of Google's
// real endpoint — exactly the same pattern this project already uses for
// EMAIL_SERVICE_URL / UPLOAD_SERVICE_URL, just for an external third party
// instead of one of our own microservices.
const VERIFY_URL = process.env.RECAPTCHA_VERIFY_URL || 'https://www.google.com/recaptcha/api/siteverify';

/**
 * Verifies one reCAPTCHA v3 token against Google's siteverify endpoint.
 *
 * Stub mode: without RECAPTCHA_SECRET_KEY configured, verification is
 * skipped entirely and always reports success — identical in spirit to how
 * the email service stays in stub mode without SENDGRID_API_KEY. This is
 * what lets every existing register/login flow (and every one of this
 * project's existing tests) keep working with no code changes and no
 * token required, while a real deployment that sets the secret key gets
 * the real, enforced check with zero code change of its own.
 *
 * Returns a result object rather than throwing — callers decide how to
 * react. Never called directly by a controller; go through
 * assertRecaptcha() below instead, which is where enforcement lives.
 */
async function verifyRecaptcha(token)
{
    if (!process.env.RECAPTCHA_SECRET_KEY)
    {
        return { enforced: false, success: true, score: 1 };
    }

    if (!token)
    {
        return { enforced: true, success: false, score: 0, reason: 'missing_token' };
    }

    try
    {
        const response = await fetch(VERIFY_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ secret: process.env.RECAPTCHA_SECRET_KEY, response: token })
        });

        if (!response.ok)
        {
            throw new Error(`reCAPTCHA endpoint responded ${response.status}`);
        }

        const body = await response.json();
        return { enforced: true, success: Boolean(body.success), score: typeof body.score === 'number' ? body.score : 0 };
    } catch (err)
    {
        // Fail CLOSED: a verification provider outage must never silently
        // disable bot protection. Reported to the caller as an infrastructure
        // problem (503), distinct from "we checked and it failed" (400) — the
        // client should retry rather than being told they look like a bot.
        logger.warn('reCAPTCHA verification unreachable', { error: err.message });
        return { enforced: true, success: false, score: 0, reason: 'unreachable' };
    }
}

/**
 * The enforcement point — call this at the top of register/login/
 * resetPassword, before any other work. Throws rather than returning a
 * result, so a single line stops the request exactly like every other
 * guard in this codebase (ownership checks, lockouts, etc.).
 */
async function assertRecaptcha(token)
{
    const result = await verifyRecaptcha(token);

    if (!result.enforced) return; // stub mode — always passes
    if (result.success && result.score >= MIN_SCORE) return; // genuinely passed

    if (result.reason === 'unreachable')
    {
        throw new UpstreamServiceError('Unable to verify reCAPTCHA right now. Please try again shortly.');
    }
    throw new ValidationError('reCAPTCHA verification failed. Please try again.');
}

module.exports = { verifyRecaptcha, assertRecaptcha, MIN_SCORE };