'use strict';

const authenticate = require('./auth.middleware.js');
const requireRole = require('./role.middleware.js');
const uploadCsv = require('./upload.middleware.js');
const { authRateLimit } = require('./rateLimit.middleware.js');
const { ROLES } = require('leadpulse-data-model').constants;

// Pre-bound convenience middleware so route.config.json can reference a
// plain string name, the same way it references "authenticate".
module.exports = {
  authenticate,
  uploadCsv,
  authRateLimit,
  requireManager: requireRole(ROLES.CAMPAIGN_MANAGER),
  requireExecutive: requireRole(ROLES.EXECUTIVE),
  requireClient: requireRole(ROLES.CLIENT),
  requireManagerOrExecutive: requireRole(ROLES.CAMPAIGN_MANAGER, ROLES.EXECUTIVE)
};
