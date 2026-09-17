'use strict';

const { ValidationError } = require('../lib');

const validateBody = (schema) => (req, res, next) => {
  const result = schema.safeParse(req.body);
  if (!result.success) {
    const details = result.error.issues.map((issue) => ({
      field: issue.path.join('.') || '(body)',
      message: issue.message
    }));
    return next(new ValidationError('One or more fields are invalid.', details));
  }
  req.body = result.data;
  next();
};

module.exports = validateBody;
