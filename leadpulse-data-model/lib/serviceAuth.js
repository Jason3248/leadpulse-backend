'use strict';

const crypto = require('crypto');

/**
 * Service-to-service authentication (SRS 5.1: "Service-to-service REST calls
 * must be authenticated using a service credential/token").
 *
 * A single shared secret carried in a header. Deliberately simple: these
 * services are only ever called by the Core Application over a private
 * network, never by a browser, so a shared secret is proportionate — full
 * mTLS or signed JWTs between services would be real complexity for no
 * additional protection at this scale.
 */

const HEADER = 'x-service-token';

const getSecret = () => process.env.SERVICE_AUTH_SECRET;

// Constant-time comparison so a wrong token can't be guessed byte-by-byte
// through response timing.
const safeEqual = (a, b) => {
  const bufA = Buffer.from(a || '', 'utf8');
  const bufB = Buffer.from(b || '', 'utf8');
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
};

/** Express middleware for a microservice to protect its own endpoints. */
const requireServiceAuth = (req, res, next) => {
  const secret = getSecret();

  // Fail closed: a missing secret is a misconfiguration, not a reason to
  // let every request through.
  if (!secret) {
    return res.status(500).json({
      success: false,
      code: 'SERVICE_MISCONFIGURED',
      message: 'Service authentication is not configured.'
    });
  }

  if (!safeEqual(req.headers[HEADER], secret)) {
    return res.status(401).json({
      success: false,
      code: 'UNAUTHORIZED',
      message: 'Invalid or missing service token.'
    });
  }

  next();
};

/** Header object for the caller side. */
const serviceAuthHeaders = () => ({ [HEADER]: getSecret() || '' });

module.exports = { requireServiceAuth, serviceAuthHeaders, SERVICE_AUTH_HEADER: HEADER };
