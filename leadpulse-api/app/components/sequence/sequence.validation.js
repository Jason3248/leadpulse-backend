'use strict';

const { z } = require('zod');

// Pricing lives on the sequence because a client contracts for the whole
// motion. Same mutual-exclusivity rule as campaigns.
const create = z
  .object({
    clientId: z.string().uuid(),
    leadListId: z.string().uuid(),
    name: z.string().trim().min(1, 'Sequence name is required').max(255),
    description: z.string().trim().max(2000).optional(),
    pricingModel: z.enum(['flat_retainer', 'cost_per_lead']).optional(),
    retainerAmount: z.number().nonnegative().optional(),
    ratePerLead: z.number().nonnegative().optional()
  })
  .refine(
    (d) => {
      if (d.pricingModel === 'flat_retainer') return d.retainerAmount != null && d.ratePerLead == null;
      if (d.pricingModel === 'cost_per_lead') return d.ratePerLead != null && d.retainerAmount == null;
      return d.retainerAmount == null && d.ratePerLead == null;
    },
    { message: 'Pricing fields must match the pricing model: flat_retainer needs retainerAmount, cost_per_lead needs ratePerLead.', path: ['pricingModel'] }
  );

const update = z
  .object({
    name: z.string().trim().min(1).max(255).optional(),
    description: z.string().trim().max(2000).nullable().optional(),
    pricingModel: z.enum(['flat_retainer', 'cost_per_lead']).nullable().optional(),
    retainerAmount: z.number().nonnegative().nullable().optional(),
    ratePerLead: z.number().nonnegative().nullable().optional()
  })
  .refine((d) => Object.keys(d).length > 0, { message: 'No fields to update.' });

module.exports = { create, update };
