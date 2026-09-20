'use strict';

const { z } = require('zod');

// Segmentation filters are all optional; any combination narrows the
// audience. membershipStatus is what powers sequence steps ("only people
// Qualified from the previous step").
const segmentationFilters = z
  .object({
    industry: z.string().trim().min(1).optional(),
    jobTitle: z.string().trim().min(1).optional(),
    source: z.string().trim().min(1).optional(),
    membershipStatus: z.enum(['New', 'Contacted', 'Qualified', 'Converted', 'Dead']).optional(),
    onlyFromCampaignId: z.string().uuid().optional()
  })
  .strict()
  .optional();

const create = z
  .object({
    clientId: z.string().uuid(),
    leadListId: z.string().uuid(),
    name: z.string().trim().min(1, 'Campaign name is required').max(255),
    type: z.enum(['email', 'call']),
    description: z.string().trim().max(2000).optional(),
    categoryTag: z.string().trim().max(100).optional(),

    // Optional sequence linkage — a step within a larger cadence.
    sequenceId: z.string().uuid().optional(),
    sequenceStepOrder: z.number().int().positive().optional(),

    segmentationFilters,
    excludeClosedLeads: z.boolean().optional(), // defaults true at the DB

    // Pricing: either flat_retainer + retainerAmount, or cost_per_lead +
    // ratePerLead, or neither. The DB CHECK constraint is the hard backstop;
    // this refine gives a friendly error before it ever gets there.
    pricingModel: z.enum(['flat_retainer', 'cost_per_lead']).optional(),
    retainerAmount: z.number().positive().optional(),
    ratePerLead: z.number().positive().optional(),

    requiresManagerApproval: z.boolean().optional(), // defaults true at the DB

    // Email-only fields — validated for presence at approval time, not here,
    // since a draft can be saved incomplete.
    subjectLine: z.string().trim().max(255).optional(),
    senderName: z.string().trim().max(150).optional(),
    replyToEmail: z.string().trim().email().optional(),
    emailBodyHtml: z.string().optional(),
    bannerImageUrl: z.string().trim().url().optional()
  })
  .refine(
    (d) =>
    {
      if (d.pricingModel === 'flat_retainer') return d.retainerAmount != null && d.ratePerLead == null;
      if (d.pricingModel === 'cost_per_lead') return d.ratePerLead != null && d.retainerAmount == null;
      // No pricing model -> neither amount should be set.
      return d.retainerAmount == null && d.ratePerLead == null;
    },
    { message: 'Pricing fields must match the pricing model: flat_retainer needs retainerAmount, cost_per_lead needs ratePerLead.', path: ['pricingModel'] }
  )
  .refine((d) => !(d.sequenceStepOrder != null && d.sequenceId == null), {
    message: 'sequenceStepOrder requires a sequenceId.',
    path: ['sequenceStepOrder']
  });

// Draft-only edit. Every field optional; the service re-checks pricing and
// targeting coherence against the MERGED result, since a partial update can
// create a contradiction that neither the old nor new values had alone.
const update = z
  .object({
    name: z.string().trim().min(1).max(255).optional(),
    description: z.string().trim().max(2000).nullable().optional(),
    categoryTag: z.string().trim().max(100).nullable().optional(),
    leadListId: z.string().uuid().optional(),
    type: z.string().optional(),
    segmentationFilters: segmentationFilters.nullable().optional(),
    excludeClosedLeads: z.boolean().optional(),
    pricingModel: z.enum(['flat_retainer', 'cost_per_lead']).nullable().optional(),
    retainerAmount: z.number().nonnegative().nullable().optional(),
    ratePerLead: z.number().nonnegative().nullable().optional(),
    requiresManagerApproval: z.boolean().optional(),
    subjectLine: z.string().trim().max(255).nullable().optional(),
    senderName: z.string().trim().max(150).nullable().optional(),
    replyToEmail: z.string().trim().email().nullable().optional(),
    emailBodyHtml: z.string().nullable().optional(),
    bannerImageUrl: z.string().trim().url().nullable().optional()
  })
  .refine((d) => Object.keys(d).length > 0, { message: 'No fields to update.' });

const assignExecutives = z.object({
  executiveUserIds: z.array(z.string().uuid()).min(1, 'At least one executive is required.')
});

const reassignLeads = z.object({
  targetExecutiveId: z.string().uuid(),
  leadIds: z.array(z.string().uuid()).min(1, 'At least one lead is required.')
});

module.exports = { create, update, assignExecutives, reassignLeads };
