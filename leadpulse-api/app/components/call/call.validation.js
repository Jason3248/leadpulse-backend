'use strict';

const { z } = require('zod');

const CALL_OUTCOMES = [
  'Answered',
  'Not Answered',
  'Busy',
  'Wrong Number',
  'Left Voicemail',
  'Callback Requested',
  'Not Interested',
  'Converted'
];

// Logging a call outcome. SRS 4.6.2: a follow-up date is required when the
// outcome is "Callback Requested" — that's the one field whose necessity
// depends on another field's value.
const logRemark = z
  .object({
    callOutcome: z.enum(CALL_OUTCOMES),
    callDurationMinutes: z.number().int().min(0).max(999).optional(),
    notes: z.string().trim().max(1000).optional(),
    followUpDate: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, 'followUpDate must be YYYY-MM-DD')
      .optional(),
    // Optional manual promotion by the executive (e.g. to Qualified). Dead
    // and Converted are driven by the outcome itself, not set here.
    leadStatusUpdate: z.enum(['Contacted', 'Qualified']).optional()
  })
  .refine((d) => !(d.callOutcome === 'Callback Requested' && !d.followUpDate), {
    message: 'A follow-up date is required when the outcome is "Callback Requested".',
    path: ['followUpDate']
  })
  .refine((d) => !(d.callOutcome !== 'Callback Requested' && d.followUpDate), {
    message: 'A follow-up date only applies to a "Callback Requested" outcome.',
    path: ['followUpDate']
  });

// Manager review of a claimed conversion. Rejecting requires a reason;
// confirming must not carry one.
const reviewConversion = z
  .object({
    confirmed: z.boolean(),
    rejectionReason: z.string().trim().min(1).max(1000).optional()
  })
  .refine((d) => !(d.confirmed === false && !d.rejectionReason), {
    message: 'A reason is required when rejecting a claimed conversion.',
    path: ['rejectionReason']
  })
  .refine((d) => !(d.confirmed === true && d.rejectionReason), {
    message: 'A rejection reason cannot be supplied when confirming.',
    path: ['rejectionReason']
  });

module.exports = { logRemark, reviewConversion };
