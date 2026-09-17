'use strict';

const { ForbiddenError } = require('../lib');

// Factory, not middleware itself — call with the allowed roles to get a
// usable middleware. See middleware/index.js for the pre-bound convenience
// exports (requireManager, requireExecutive, ...) that route.config.json
// can reference directly by name.
const requireRole =
  (...allowedRoles) =>
  (req, res, next) => {
    if (!req.user || !allowedRoles.includes(req.user.role)) {
      return next(new ForbiddenError('You do not have permission to perform this action'));
    }
    next();
  };

module.exports = requireRole;
