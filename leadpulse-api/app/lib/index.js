'use strict';

const AppError = require('./AppError.js');

class ValidationError extends AppError {
  constructor(message = 'Request validation failed', details = []) {
    super(message, 400, 'VALIDATION_ERROR');
    this.details = details;
  }
}

class NotFoundError extends AppError {
  constructor(message = 'Requested resource not found') {
    super(message, 404, 'NOT_FOUND');
  }
}

class ConflictError extends AppError {
  constructor(message = 'Resource conflict') {
    super(message, 409, 'CONFLICT');
  }
}

class UnauthorizedError extends AppError {
  constructor(message = 'Authentication required') {
    super(message, 401, 'UNAUTHORIZED');
  }
}

class ForbiddenError extends AppError {
  constructor(message = 'You do not have permission to perform this action') {
    super(message, 403, 'FORBIDDEN');
  }
}

// 422 — the request is well-formed and authorized, but violates one of the
// domain rules we designed the schema around (e.g. self-confirmation,
// pricing model mismatch, targeting a DNC lead).
class BusinessRuleError extends AppError {
  constructor(message = 'This action violates a business rule') {
    super(message, 422, 'BUSINESS_RULE_ERROR');
  }
}

// 503 — a dependency this request needed (the upload service, the email
// service) is unreachable or errored. Distinct from a business rule
// violation: this is an infrastructure failure, not a domain one, and the
// client should generally just retry rather than change what it sent.
class UpstreamServiceError extends AppError {
  constructor(message = 'A required service is currently unavailable. Please try again shortly.') {
    super(message, 503, 'UPSTREAM_SERVICE_ERROR');
  }
}

module.exports = {
  AppError,
  ValidationError,
  NotFoundError,
  ConflictError,
  UnauthorizedError,
  ForbiddenError,
  BusinessRuleError,
  UpstreamServiceError
};
