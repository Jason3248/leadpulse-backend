'use strict';

/**
 * Single source of truth for every enum used across the schema.
 * Both the API package and the data-model package's own migrations/services
 * should reference these instead of hardcoding string literals, so a value
 * only ever needs to change in one place.
 */

const ROLES = {
  CAMPAIGN_MANAGER: 'campaign_manager',
  EXECUTIVE: 'executive',
  CLIENT: 'client'
};

const LEAD_LIST_STATUS = {
  ACTIVE: 'active',
  ARCHIVED: 'archived'
};

// Per-list lifecycle status (lives on lead_list_memberships, NOT on leads
// itself — the same person can independently be Converted on one list/product
// and New on another).
const MEMBERSHIP_STATUS = {
  NEW: 'New',
  CONTACTED: 'Contacted',
  QUALIFIED: 'Qualified',
  CONVERTED: 'Converted',
  DEAD: 'Dead'
};

// The order automatic transitions are allowed to move forward through.
// Dead is reachable from any state via an explicit negative signal, but is
// intentionally excluded from this ordered list — see leadStatus.service.js.
const MEMBERSHIP_STATUS_ORDER = [
  MEMBERSHIP_STATUS.NEW,
  MEMBERSHIP_STATUS.CONTACTED,
  MEMBERSHIP_STATUS.QUALIFIED,
  MEMBERSHIP_STATUS.CONVERTED
];

const IMPORT_JOB_STATUS = {
  UPLOADED: 'uploaded',
  QUEUED: 'queued',
  PROCESSING: 'processing',
  COMPLETED: 'completed',
  COMPLETED_WITH_ERRORS: 'completed_with_errors',
  FAILED: 'failed'
};

const IMPORT_JOB_TERMINAL_STATUSES = [
  IMPORT_JOB_STATUS.COMPLETED,
  IMPORT_JOB_STATUS.COMPLETED_WITH_ERRORS,
  IMPORT_JOB_STATUS.FAILED
];

const CAMPAIGN_TYPE = {
  EMAIL: 'email',
  CALL: 'call'
};

const CAMPAIGN_STATUS = {
  DRAFT: 'draft',
  ACTIVE: 'active',
  PAUSED: 'paused',
  COMPLETED: 'completed'
};

const DISPATCH_STATUS = {
  NOT_SENT: 'not_sent',
  SENDING: 'sending',
  SENT: 'sent'
};

const PRICING_MODEL = {
  FLAT_RETAINER: 'flat_retainer',
  COST_PER_LEAD: 'cost_per_lead'
};

const SCHEDULE_TYPE = {
  SEND_NOW: 'send_now',
  SCHEDULED: 'scheduled'
};

const QUEUE_STATUS = {
  PENDING: 'pending',
  IN_PROGRESS: 'in_progress',
  CALLED: 'called',
  SKIPPED: 'skipped',
  COMPLETED: 'completed'
};

const ENGAGEMENT_STATUS = {
  SENT: 'sent',
  DELIVERED: 'delivered',
  BOUNCED: 'bounced',
  SPAMREPORT: 'spamreport'
};

const BOUNCE_TYPE = {
  HARD: 'hard',
  SOFT: 'soft'
};

const CALL_OUTCOME = {
  ANSWERED: 'Answered',
  NOT_ANSWERED: 'Not Answered',
  BUSY: 'Busy',
  WRONG_NUMBER: 'Wrong Number',
  LEFT_VOICEMAIL: 'Left Voicemail',
  CALLBACK_REQUESTED: 'Callback Requested',
  NOT_INTERESTED: 'Not Interested',
  CONVERTED: 'Converted'
};

module.exports = {
  ROLES,
  LEAD_LIST_STATUS,
  MEMBERSHIP_STATUS,
  MEMBERSHIP_STATUS_ORDER,
  IMPORT_JOB_STATUS,
  IMPORT_JOB_TERMINAL_STATUSES,
  CAMPAIGN_TYPE,
  CAMPAIGN_STATUS,
  DISPATCH_STATUS,
  PRICING_MODEL,
  SCHEDULE_TYPE,
  QUEUE_STATUS,
  ENGAGEMENT_STATUS,
  BOUNCE_TYPE,
  CALL_OUTCOME
};
