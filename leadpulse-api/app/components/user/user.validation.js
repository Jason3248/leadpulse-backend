'use strict';

const { z } = require('zod');

// Mirrors the password policy in auth.validation.js (SRS 4.1.1). A Manager
// may set a temporary password explicitly; if omitted, one is generated.
const passwordSchema = z
  .string()
  .min(8, 'Password must be at least 8 characters')
  .regex(/[A-Z]/, 'Password must contain at least one uppercase letter')
  .regex(/[0-9]/, 'Password must contain at least one digit')
  .regex(/[^A-Za-z0-9]/, 'Password must contain at least one special character');

const createExecutive = z.object({
  firstName: z.string().trim().min(1, 'First name is required').max(50),
  lastName: z.string().trim().min(1, 'Last name is required').max(50),
  email: z.string().trim().toLowerCase().email('Invalid email address'),
  temporaryPassword: passwordSchema.optional()
});

const createClientUser = z.object({
  clientId: z.string().uuid('clientId must be a valid UUID'),
  firstName: z.string().trim().min(1, 'First name is required').max(50),
  lastName: z.string().trim().min(1, 'Last name is required').max(50),
  email: z.string().trim().toLowerCase().email('Invalid email address'),
  temporaryPassword: passwordSchema.optional()
});

module.exports = { createExecutive, createClientUser };
