'use strict';

const { NotFoundError } = require('../lib');

module.exports = (req, res, next) => {
  next(new NotFoundError(`Route ${req.method} ${req.originalUrl} not found`));
};
