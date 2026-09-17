'use strict';

const rateLimit = require('express-rate-limit');
const logger = require('../configs/logger.js');

// One shared limiter across the four auth endpoints that take user-supplied
// credentials or tokens as guessable input (register, login,
// forgot-password, reset-password). Not applied to refresh/logout/me —
// those already require a valid session or an unguessable 40-byte token,
// so a raw request-count cap adds little there.
//
// In-memory store (the package's default) — fine at this scale, and
// consistent with the SRS's no-Redis/no-message-queue constraint. The only
// cost is that limits reset if the process restarts, which is an
// acceptable trade-off for a project this size.
const authRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 20, // 20 requests per IP, per window, shared across all four routes
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => {
    logger.warn('Rate limit exceeded', { ip: req.ip, path: req.originalUrl });
    res.status(429).json({
      success: false,
      code: 'TOO_MANY_REQUESTS',
      message: 'Too many requests from this IP. Please try again later.',
      timestamp: new Date().toISOString()
    });
  }
});

module.exports = { authRateLimit };
