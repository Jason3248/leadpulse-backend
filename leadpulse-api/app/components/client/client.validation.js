'use strict';

const { z } = require('zod');

const create = z.object({
  name: z.string().trim().min(1, 'Client name is required').max(255),
  contactPerson: z.string().trim().max(255).optional(),
  contactEmail: z.string().trim().toLowerCase().email('Invalid email address').optional()
});

const update = z.object({
  name: z.string().trim().min(1).max(255).optional(),
  contactPerson: z.string().trim().max(255).optional(),
  contactEmail: z.string().trim().toLowerCase().email('Invalid email address').optional()
});

module.exports = { create, update };
