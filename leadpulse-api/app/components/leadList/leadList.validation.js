'use strict';

const { z } = require('zod');

const create = z.object({
  clientId: z.string().uuid('clientId must be a valid UUID'),
  name: z.string().trim().min(1, 'List name is required').max(255)
});

module.exports = { create };
