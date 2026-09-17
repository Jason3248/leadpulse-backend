'use strict';

const { z } = require('zod');

const emptyToUndefined = (val) => (val === '' ? undefined : val);

const importLeads = z
  .object({
    clientId: z.string().uuid('clientId must be a valid UUID'),
    leadListId: z.preprocess(emptyToUndefined, z.string().uuid().optional()),
    leadListName: z.preprocess(emptyToUndefined, z.string().trim().min(1).max(255).optional())
  })
  .refine((data) => Boolean(data.leadListId) !== Boolean(data.leadListName), {
    message: 'Provide exactly one of leadListId (existing list) or leadListName (new list)',
    path: ['leadListId']
  });

const updateDnc = z.object({
  clientId: z.string().uuid('clientId must be a valid UUID'),
  dnc: z.boolean()
});

const updateStatus = z.object({
  leadListId: z.string().uuid('leadListId must be a valid UUID'),
  status: z.enum(['New', 'Contacted', 'Qualified', 'Converted', 'Dead'])
});

module.exports = { importLeads, updateDnc, updateStatus };
