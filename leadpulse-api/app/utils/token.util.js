'use strict';

const jwt = require('jsonwebtoken');
const crypto = require('crypto');

const ACCESS_TOKEN_EXPIRY = '15m';
const REFRESH_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const RESET_TOKEN_TTL_MS = 60 * 60 * 1000; // 60 minutes

// Stateless access token — carries tokenVersion so the auth middleware can
// reject a token that was already issued but should no longer be trusted
// (password reset, deactivation, logout), without needing a token blocklist.
const generateAccessToken = (user) =>
  jwt.sign({ userId: user.id, role: user.role, tokenVersion: user.tokenVersion }, process.env.JWT_ACCESS_SECRET, {
    expiresIn: ACCESS_TOKEN_EXPIRY
  });

// Refresh and password-reset tokens are high-entropy random strings, not
// JWTs — only their SHA-256 hash is ever persisted, same pattern as a
// password hash, so a DB leak alone can't be used to forge a session.
const generateOpaqueToken = () => crypto.randomBytes(40).toString('hex');

const hashOpaqueToken = (token) => crypto.createHash('sha256').update(token).digest('hex');

module.exports = {
  generateAccessToken,
  generateOpaqueToken,
  hashOpaqueToken,
  REFRESH_TOKEN_TTL_MS,
  RESET_TOKEN_TTL_MS
};
