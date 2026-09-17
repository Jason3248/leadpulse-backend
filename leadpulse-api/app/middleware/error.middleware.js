'use strict';

const logger = require('../configs/logger.js');
const { AppError } = require('../lib');

module.exports = (err, req, res, next) => {
  if (err instanceof AppError) {
    if (err.statusCode >= 500) {
      logger.error(err.message, { stack: err.stack, code: err.code, path: req.originalUrl });
    } else {
      logger.warn(err.message, { code: err.code, path: req.originalUrl });
    }

    return res.status(err.statusCode).json({
      success: false,
      code: err.code,
      message: err.message,
      ...(err.details ? { details: err.details } : {}),
      timestamp: new Date().toISOString()
    });
  }

  // A unique constraint fired at the DB layer even though app-level logic
  // should have caught it first (e.g. leads_client_id_email_unique,
  // campaign_leads_campaign_lead_unique) — translate, don't leak raw SQL.
  if (err.name === 'SequelizeUniqueConstraintError') {
    logger.warn('Unique constraint violated', { path: req.originalUrl, fields: err.fields });
    return res.status(409).json({
      success: false,
      code: 'CONFLICT',
      message: 'A record with these details already exists.',
      timestamp: new Date().toISOString()
    });
  }

  if (err.name === 'SequelizeForeignKeyConstraintError') {
    logger.warn('Foreign key constraint violated', { path: req.originalUrl });
    return res.status(409).json({
      success: false,
      code: 'CONFLICT',
      message: 'This action references a record that does not exist or cannot be modified.',
      timestamp: new Date().toISOString()
    });
  }

  // Our business-rule CHECK constraints (pricing mutual exclusivity,
  // no-self-confirmation, confirmation-field consistency) surface here as
  // the last line of defense if a bug ever let a bad write past the service
  // layer — treated as a business rule violation, not a server crash.
  if (err.name === 'SequelizeDatabaseError' && /violates check constraint/i.test(err.message)) {
    logger.warn('Check constraint violated', { path: req.originalUrl, message: err.message });
    return res.status(422).json({
      success: false,
      code: 'BUSINESS_RULE_ERROR',
      message: 'This action violates a business rule and cannot be completed.',
      timestamp: new Date().toISOString()
    });
  }

  // Unrecognized error (programming bug, etc.) — never leak internals.
  logger.error('Unhandled error', { stack: err.stack, message: err.message, path: req.originalUrl });

  return res.status(500).json({
    success: false,
    code: 'INTERNAL_SERVER_ERROR',
    message: 'Something went wrong. Please try again later.',
    timestamp: new Date().toISOString()
  });
};
