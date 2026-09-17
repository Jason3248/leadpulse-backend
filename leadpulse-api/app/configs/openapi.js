'use strict';

const routes = require('./route.config.json');

/**
 * Builds an OpenAPI 3 spec from the actual route table, so Swagger can never
 * drift from the real routes. Per-endpoint prose (what it does, which tables
 * it touches, why it exists) lives in DOCS below, keyed by "METHOD path".
 *
 * The "tables" note on each endpoint answers a specific question the team
 * asked: for any given call, which database tables are read or written.
 */

const SERVER = process.env.SWAGGER_SERVER || 'http://localhost:4000';

// Human notes per endpoint. Anything not listed still appears in Swagger,
// just without the extra prose.
const DOCS = {
  // ---- AUTH ----
  'POST /api/v1/auth/register': {
    summary: 'Register a Campaign Manager (self-service)',
    desc: 'The only self-service signup. Creates the tenant boundary everything else hangs off. Sends a welcome email. `recaptchaToken` is required only when RECAPTCHA_SECRET_KEY is configured server-side — omit it in local/stub mode.',
    tables: 'WRITE users. (welcome email via email service)',
    body: { firstName: 'Asha', lastName: 'Rao', email: 'asha@acme-agency.com', password: 'Str0ng!Pass', confirmPassword: 'Str0ng!Pass', recaptchaToken: '<from the reCAPTCHA v3 widget, if enforced>' }
  },
  'POST /api/v1/auth/login': {
    summary: 'Log in, get an access token',
    desc: 'Returns a 15-min access token and sets a 7-day refresh cookie. 5 failed attempts locks the account for 15 min. `recaptchaToken` required only when reCAPTCHA is enforced server-side.',
    tables: 'READ users; WRITE users (failedLoginAttempts, lockedUntil, lastLoginAt, refreshTokenHash).',
    body: { email: 'asha@acme-agency.com', password: 'Str0ng!Pass', recaptchaToken: '<from the reCAPTCHA v3 widget, if enforced>' }
  },
  'POST /api/v1/auth/refresh': {
    summary: 'Silent refresh — new access token from the refresh cookie',
    desc: 'Rotates the refresh token on every use. No body; reads the httpOnly cookie.',
    tables: 'READ/WRITE users (refreshTokenHash).'
  },
  'POST /api/v1/auth/logout': {
    summary: 'Log out — revokes the session immediately',
    desc: 'Clears the refresh token AND bumps tokenVersion, so the current access token stops working at once, not on expiry.',
    tables: 'WRITE users (tokenVersion, refreshTokenHash).'
  },
  'POST /api/v1/auth/forgot-password': {
    summary: 'Request a password reset link',
    desc: 'Always returns the same response whether or not the email exists (no enumeration). Emails a single-use token.',
    tables: 'READ users; WRITE users (resetTokenHash, resetTokenExpiresAt).',
    body: { email: 'asha@acme-agency.com' }
  },
  'POST /api/v1/auth/reset-password': {
    summary: 'Complete a password reset',
    desc: 'Consumes the token, sets the new password, invalidates all sessions and clears any lockout. `recaptchaToken` required only when reCAPTCHA is enforced server-side.',
    tables: 'READ/WRITE users.',
    body: { token: '<from email>', password: 'NewStr0ng!Pass', confirmPassword: 'NewStr0ng!Pass', recaptchaToken: '<from the reCAPTCHA v3 widget, if enforced>' }
  },
  'GET /api/v1/auth/me': { summary: 'Current user', desc: 'The authenticated user\'s own safe profile.', tables: 'READ users.' },
  'PATCH /api/v1/auth/change-password': {
    summary: 'Change my own password (any role)',
    desc: 'The self-service counterpart to reset-password: proof of identity here is knowing the CURRENT password, not owning the email inbox. Available to every role — Manager, Executive, and Client alike. Invalidates every other session (bumps tokenVersion, clears the refresh token) — the same treatment as completing a reset-link.',
    tables: 'READ/WRITE users.',
    body: { currentPassword: 'Str0ng!Pass', newPassword: 'EvenStr0nger!Pass', confirmNewPassword: 'EvenStr0nger!Pass' }
  },
  'PATCH /api/v1/auth/profile': {
    summary: 'Update my display name (any role)',
    desc: 'The other half of SRS 4.11\'s "Profile: update display name and change password". Update firstName and/or lastName — at least one must be provided.',
    tables: 'WRITE users.',
    body: { firstName: 'Asha', lastName: 'Rao' }
  },

  // ---- CLIENT ----
  'POST /api/v1/clients': {
    summary: 'Create a client', desc: 'The client is the tenant anchor: lead lists, campaigns and portal users all scope to it.',
    tables: 'WRITE clients.', body: { name: 'Acme Corp', contactPerson: 'Mark', contactEmail: 'mark@acme.com' }
  },
  'GET /api/v1/clients': { summary: 'List my clients', desc: 'Only clients owned by this manager.', tables: 'READ clients.' },
  'GET /api/v1/clients/:id': { summary: 'Get one client', desc: 'Owner-manager, or that client\'s own portal user.', tables: 'READ clients.' },
  'PATCH /api/v1/clients/:id': { summary: 'Edit a client', tables: 'WRITE clients.', body: { name: 'Acme Corporation' } },
  'PATCH /api/v1/clients/:id/deactivate': { summary: 'Deactivate a client', desc: 'Freezes NEW work (imports, campaigns, sends) but never erases history and never blocks reads.', tables: 'WRITE clients (isActive).' },
  'PATCH /api/v1/clients/:id/reactivate': { summary: 'Reactivate a client', tables: 'WRITE clients (isActive).' },

  // ---- USER (executives & client portal users) ----
  'POST /api/v1/users/executives': {
    summary: 'Create an executive', desc: 'Agency staff, manager-owned, no client attached. Temp password generated if omitted, emailed, only its hash stored.',
    tables: 'READ users (dup check); WRITE users. (credentials email)', body: { firstName: 'Raj', lastName: 'Kumar', email: 'raj@acme-agency.com' }
  },
  'GET /api/v1/users/executives': { summary: 'Team page', desc: 'Each executive with assigned campaigns, calls logged, and OPEN (unworked) lead count — the last matters before deactivating.', tables: 'READ users, campaign_executives, campaigns, call_remarks, campaign_leads.' },
  'POST /api/v1/users/client-users': {
    summary: 'Create a client portal user', desc: 'Read-only, scoped to one client. Same credential-email flow as executives.',
    tables: 'READ clients (ownership), users (dup); WRITE users. (credentials email)', body: { clientId: '<client id>', firstName: 'Mark', lastName: 'Client', email: 'mark@acme.com' }
  },
  'GET /api/v1/users/client-users': {
    summary: 'List client portal users', tables: 'READ users.',
    query: [{ name: 'clientId', desc: 'Restrict to one client' }]
  },
  'PATCH /api/v1/users/:id/deactivate': { summary: 'Deactivate a user', desc: 'Blocks login AND bumps tokenVersion so existing tokens die immediately. Warns (in logs) if an executive still holds open leads.', tables: 'WRITE users; READ campaign_leads.' },
  'PATCH /api/v1/users/:id/reactivate': { summary: 'Reactivate a user', tables: 'WRITE users.' },
  'POST /api/v1/users/:id/reset-password': { summary: 'Manager-triggered reset', desc: 'Emails a single-use link; the manager never sees or sets the password.', tables: 'WRITE users (resetTokenHash). (reset email)' },

  // ---- LEADLIST ----
  'POST /api/v1/lead-lists': { summary: 'Create an empty lead list', desc: 'A named container for a client\'s leads. Reuses an existing same-name list (case-insensitive) instead of duplicating.', tables: 'READ clients; READ/WRITE lead_lists.', body: { clientId: '<client id>', name: 'Q3 Prospects' } },
  'GET /api/v1/lead-lists': {
    summary: 'Lead lists for a client', desc: 'Each with a live lead count.',
    tables: 'READ lead_lists, lead_list_memberships.',
    query: [{ name: 'clientId', required: true, desc: 'Required — lists are always client-scoped', example: 'paste a client id' }]
  },
  'GET /api/v1/lead-lists/:id': { summary: 'One lead list', tables: 'READ lead_lists, lead_list_memberships.' },
  'PATCH /api/v1/lead-lists/:id/archive': { summary: 'Archive a list', desc: 'Retires it — no new campaign can target it. Existing campaigns are unaffected.', tables: 'WRITE lead_lists (status).' },

  // ---- LEAD IMPORT & LEADS ----
  'POST /api/v1/leads/import': {
    summary: 'Start an async CSV/XLSX import',
    desc: 'Returns **202 + a job id immediately** — the file is parsed by the upload microservice in the background. Poll `/leads/imports/{jobId}/status` until terminal.\n\nCSV headers must be exactly: `first_name,last_name,email,phone,company,job_title,industry,source`.\n\nProvide EITHER `leadListName` (creates a new list) OR `leadListId` (appends to an existing one) — not both.',
    tables: 'WRITE import_jobs; (async) READ/WRITE leads, client_leads, lead_list_memberships, lead_lists.',
    multipart: {
      clientId: { desc: 'The client this list belongs to', example: 'paste a client id from POST /clients' },
      leadListName: { desc: 'Name for a NEW list (omit if using leadListId)', example: 'Q3 Prospects' },
      leadListId: { desc: 'Existing list to append to (omit if using leadListName)' },
      file: { file: true, desc: 'A .csv or .xlsx file' }
    },
    multipartRequired: ['clientId', 'file']
  },
  'GET /api/v1/leads/imports': { summary: 'Import history', tables: 'READ import_jobs.' },
  'GET /api/v1/leads/imports/:jobId/status': { summary: 'Poll an import job', desc: 'Progress %, counts, and status. Also rescues a job stuck in "processing" past 30 min.', tables: 'READ/WRITE import_jobs.' },
  'GET /api/v1/leads/imports/:jobId/errors': { summary: 'Download the error-rows CSV', desc: 'The rows that failed validation, with reasons — fix and re-upload.', tables: 'READ import_jobs; storage.' },
  'GET /api/v1/leads': {
    summary: 'List leads for a client',
    desc: 'Paginated, with optional filters. `status` filters on the per-LIST membership status, so pair it with `leadListId` for an unambiguous result.',
    tables: 'READ client_leads, leads, lead_list_memberships.',
    query: [
      { name: 'clientId', required: true, desc: 'Required', example: 'paste a client id' },
      { name: 'leadListId', desc: 'Restrict to one list' },
      { name: 'status', enum: ['New', 'Contacted', 'Qualified', 'Converted', 'Dead'], desc: 'Per-list funnel status' },
      { name: 'industry', desc: 'Partial match', example: 'Manufacturing' },
      { name: 'jobTitle', desc: 'Partial match', example: 'VP' },
      { name: 'source', desc: 'Partial match', example: 'LinkedIn' },
      { name: 'page', type: 'integer', example: 1 },
      { name: 'pageSize', type: 'integer', desc: 'Max 100', example: 25 }
    ]
  },
  'GET /api/v1/leads/:id': {
    summary: "One lead (this client's view)",
    desc: 'Shows the person plus their per-list statuses **for this client only**. Another client\'s lists for the same real person are never revealed — the ethical firewall.',
    tables: 'READ leads, client_leads, lead_list_memberships, lead_lists.',
    query: [{ name: 'clientId', required: true, desc: 'Required — decides whose view of the lead you get', example: 'paste a client id' }]
  },
  'PATCH /api/v1/leads/:id/dnc': { summary: 'Set/clear Do-Not-Contact', desc: 'Per client relationship. Blocks all future contact for that client, live-checked at send/call time.', tables: 'WRITE client_leads (dnc).', body: { clientId: '<client id>', dnc: true } },
  'PATCH /api/v1/leads/:id/status': { summary: 'Manual status override', desc: 'A manager can move a lead\'s per-list status in ANY direction (correcting a mistake) — the only path exempt from the forward-only guard.', tables: 'WRITE lead_list_memberships (status).', body: { leadListId: '<list id>', status: 'Qualified' } },

  // ---- CAMPAIGN ----
  'POST /api/v1/campaigns': {
    summary: 'Create a draft campaign', desc: 'Email or call. Segmentation, pricing and sequence linkage are set here; the audience is NOT frozen yet.',
    tables: 'READ clients, lead_lists, sequences; WRITE campaigns.',
    body: { clientId: '<id>', leadListId: '<id>', name: 'Q3 Calls', type: 'call', pricingModel: 'cost_per_lead', ratePerLead: 8 }
  },
  'GET /api/v1/campaigns': {
    summary: 'List campaigns', desc: 'Manager-owned only.',
    tables: 'READ clients, campaigns.',
    query: [
      { name: 'clientId', desc: 'Restrict to one client' },
      { name: 'status', enum: ['draft', 'active', 'paused', 'completed'] },
      { name: 'type', enum: ['email', 'call'] }
    ]
  },
  'GET /api/v1/campaigns/:id': { summary: 'Campaign detail', desc: 'Includes assigned executives and the frozen audience count.', tables: 'READ campaigns, campaign_executives, users, campaign_leads.' },
  'PATCH /api/v1/campaigns/:id': { summary: 'Edit a DRAFT campaign', desc: 'Only while draft — once approved the audience is frozen and edits would desync it.', tables: 'WRITE campaigns.', body: { subjectLine: 'Hello {{first_name}}', emailBodyHtml: '<p>Hi {{first_name}}</p>' } },
  'POST /api/v1/campaigns/:id/executives': { summary: 'Assign executives', desc: 'Multiple allowed. Each newly-assigned executive is emailed. On approval their share of the audience is split round-robin.', tables: 'READ users; WRITE campaign_executives. (assignment email)', body: { executiveUserIds: ['<exec id>'] } },
  'DELETE /api/v1/campaigns/:id/executives/:executiveId': { summary: 'Unassign an executive', desc: 'Soft-closes the assignment (history kept) and returns their still-pending leads to the unassigned pool.', tables: 'WRITE campaign_executives, campaign_leads.' },
  'POST /api/v1/campaigns/:id/reassign-leads': { summary: 'Hand specific leads to an executive', desc: 'Manual override of the auto-split. Only PENDING leads move; the target must be actively assigned.', tables: 'READ campaign_executives; WRITE campaign_leads.', body: { targetExecutiveId: '<exec id>', leadIds: ['<lead id>'] } },
  'PATCH /api/v1/campaigns/:id/approve': {
    summary: 'Approve — THIS is where the audience FREEZES',
    desc: 'Runs segmentation once, writes one campaign_leads row per targeted lead, round-robin-splits call leads across executives, sets status Active. The single most important transition.',
    tables: 'READ lead_list_memberships, leads, client_leads, campaign_executives; WRITE campaign_leads, campaigns.'
  },
  'PATCH /api/v1/campaigns/:id/pause': { summary: 'Pause', desc: 'Closes the call queue / blocks dispatch until resumed.', tables: 'WRITE campaigns (status).' },
  'PATCH /api/v1/campaigns/:id/resume': { summary: 'Resume', tables: 'WRITE campaigns (status).' },
  'PATCH /api/v1/campaigns/:id/end': { summary: 'End early', desc: 'Terminal. For call campaigns, sweeps still-open queue rows to "skipped" without touching the leads\' own status.', tables: 'WRITE campaigns (status), campaign_leads (queueStatus).' },

  // ---- CALL ENGINE ----
  'GET /api/v1/call/my-campaigns': { summary: '[Executive] My assigned call campaigns', desc: 'With my pending-lead count per campaign.', tables: 'READ campaign_executives, campaigns, clients, campaign_leads.' },
  'GET /api/v1/call/campaigns/:campaignId/next': {
    summary: '[Executive] Serve the next lead (Call Card)',
    desc: 'Oldest pending/in-progress/called lead in MY slice. Runs the LIVE contactability check first: a lead now DNC or already Converted/Dead elsewhere is skipped on the spot. Returns null + queueExhausted when done.',
    tables: 'READ campaign_leads, lead_list_memberships, client_leads, leads, call_remarks; WRITE campaign_leads (skips).'
  },
  'POST /api/v1/call/leads/:campaignLeadId/remarks': {
    summary: '[Executive] Log a call outcome',
    desc: 'Creates a remark and advances the queue. Not Interested -> Dead automatically; Converted -> waits for review; Callback Requested -> stays in_progress (needs followUpDate); anything else -> at least Contacted.',
    tables: 'WRITE call_remarks, campaign_leads (queueStatus), lead_list_memberships (status).',
    body: { callOutcome: 'Callback Requested', callDurationMinutes: 3, notes: 'Call back Tuesday', followUpDate: '2026-02-01' }
  },
  'POST /api/v1/call/leads/:campaignLeadId/skip': {
    summary: '[Executive] Skip a lead — no call happened',
    desc: 'The gap between logRemark\'s options: passing on a lead RIGHT NOW without fabricating an outcome (no "Not Answered" for a call that was never dialed). Writes NO call_remarks row — queueStatus is untouched. Stamps last_skipped_at, which /next treats exactly like a genuine attempt for ordering — the lead drops to the back of this executive\'s queue and returns once everything else has had a turn.',
    tables: 'WRITE campaign_leads (lastSkippedAt only — never call_remarks).'
  },
  'GET /api/v1/call/leads/:campaignLeadId': {
    summary: "[Executive] One lead's full detail, by id",
    desc: 'The same card shape /next returns (previousRemarks, phone, company, jobTitle, industry, email) for a SPECIFIC known lead — the piece callbacks-due was missing, since that list only returns a reduced summary. Purely read-only: no live consent re-check, no side effects, looking something up never retires it.',
    tables: 'READ campaign_leads, leads, call_remarks.'
  },
  'GET /api/v1/call/campaigns/:campaignId/callbacks-due': { summary: 'Callbacks due/overdue', desc: 'Only the LATEST remark per lead counts, so a superseded callback drops off. Manager sees all; executive sees own. Each entry\'s campaignLeadId can be passed to GET /call/leads/{campaignLeadId} for the full card before acting on it.', tables: 'READ campaign_leads, leads, call_remarks.' },
  'GET /api/v1/call/campaigns/:campaignId/pending-conversions': { summary: '[Manager] Conversion review inbox', desc: 'Claimed conversions awaiting confirmation.', tables: 'READ campaign_leads, call_remarks, leads, users.' },
  'PATCH /api/v1/call/remarks/:remarkId/review': {
    summary: '[Manager] Confirm or reject a conversion',
    desc: 'The billing gate. Confirm -> lead becomes Converted and it counts toward billing. Reject -> reason recorded, lead untouched. The reviewer can never be the reporting executive (DB-enforced).',
    tables: 'WRITE call_remarks (conversionConfirmed...), lead_list_memberships (status on confirm).',
    body: { confirmed: true }
  },
  'GET /api/v1/call/campaigns/:campaignId/progress': { summary: '[Manager] Progress rollup', desc: 'Queue counts, per-executive stats, and live billing from CONFIRMED conversions only.', tables: 'READ campaign_leads, call_remarks, users, campaigns.' },

  // ---- EMAIL ENGINE ----
  'POST /api/v1/email/campaigns/:campaignId/dispatch': {
    summary: 'Dispatch an email campaign (async)',
    desc: 'Returns 202. Atomic dispatch-status guard prevents a double-send. The send loop live-checks consent per recipient and batches 50 at a time.',
    tables: 'WRITE email_dispatch_jobs, campaigns (dispatchStatus); (async) WRITE lead_engagements, lead_list_memberships, READ client_leads.'
  },
  'GET /api/v1/email/dispatches/:jobId': { summary: 'Poll a dispatch job', desc: 'sent / failed / suppressed counters (they reconcile to processed). Rescues a stalled job.', tables: 'READ/WRITE email_dispatch_jobs.' },
  'GET /api/v1/email/campaigns/:campaignId/dispatches': { summary: 'Dispatch history for a campaign', tables: 'READ email_dispatch_jobs.' },
  'GET /api/v1/email/campaigns/:campaignId/analytics': { summary: '[Manager] Email analytics', desc: 'Full funnel + rates (delivery/open/CTR/CTOR/bounce/unsub) + alert flags + billing.', tables: 'READ campaign_leads, lead_engagements, campaigns.' },
  'GET /api/v1/track/open': {
    summary: '[Public] Open tracking pixel',
    desc: 'Hit automatically by the recipient\'s email client when it loads images. Returns a 1x1 GIF, stamps `openedAt`, increments `openCount`. An **open does NOT promote status** — too weak a signal. Fails silently on a bad token (never an enumeration oracle).\n\n**To test manually:** get a `trackingToken` from the `lead_engagements` table after a dispatch, then call this.',
    tables: 'READ/WRITE lead_engagements.',
    query: [{ name: 'token', required: true, desc: 'lead_engagements.tracking_token', example: 'paste a trackingToken' }]
  },
  'GET /api/v1/track/click': {
    summary: '[Public] Click redirect',
    desc: 'Records the click, **promotes the lead to Qualified** (a click is a real interest signal, unlike an open), then 302-redirects to the original URL. Only http(s) targets are followed — a tampered `javascript:` URL is refused.',
    tables: 'READ/WRITE lead_engagements, lead_list_memberships.',
    query: [
      { name: 'token', required: true, desc: 'lead_engagements.tracking_token', example: 'paste a trackingToken' },
      { name: 'url', required: true, desc: 'URL-encoded destination', example: 'https://example.com/offer' }
    ]
  },
  'GET /api/v1/track/convert': {
    summary: '[Public] Conversion confirmation PAGE (does not convert)',
    desc: 'A GET **only renders a form** — it never writes anything. This is deliberate: corporate mail scanners (Safe Links, AV gateways) prefetch every link in an email, and a GET that converted would mark leads Converted and bill the client for conversions that never happened. The actual conversion is the POST below.',
    tables: 'none.',
    query: [{ name: 'token', required: true, example: 'paste a trackingToken' }]
  },
  'POST /api/v1/track/convert': {
    summary: '[Public] Confirm interest — THE REAL CONVERSION',
    desc: 'The lead\'s own click promotes them straight to **Converted** with no human confirmation — unlike a self-reported call outcome, a click cannot be faked by the agency.\n\nIf the campaign belongs to a sequence, this also writes the billing ledger row. A lead who already converted earlier in the same sequence is **not billed again** (the ledger\'s unique constraint rejects it) but still sees a normal thank-you page.',
    tables: 'WRITE lead_engagements, lead_list_memberships, sequence_conversions.',
    body: { token: 'paste a trackingToken' },
    note: 'Sent as form data by the confirmation page; Swagger will send JSON, which the API also accepts.'
  },
  'GET /api/v1/track/unsubscribe': {
    summary: '[Public] Unsubscribe confirmation PAGE (does not unsubscribe)',
    desc: 'GET renders a form; only the POST acts. Same scanner-prefetch reasoning as convert — this is why RFC 8058 mandates POST for one-click unsubscribe.',
    tables: 'none.',
    query: [{ name: 'token', required: true, example: 'paste a trackingToken' }]
  },
  'POST /api/v1/track/unsubscribe': {
    summary: '[Public] Unsubscribe — THE REAL ACTION',
    desc: 'Sets `isUnsubscribed` on the **client relationship**: it silences every campaign that client runs, but never affects a different client\'s outreach to the same real person. Does **not** mark the lead Dead — consent and funnel-stage are independent.',
    tables: 'WRITE lead_engagements, client_leads.',
    body: { token: 'paste a trackingToken' }
  },
  'POST /api/v1/webhooks/sendgrid': {
    summary: '[Public] SendGrid event webhook',
    desc: 'Accepts an ARRAY of provider events. A **hard bounce** (`type` anything other than `blocked`) immediately sets `isHardBounced` for that client — per-lead, no threshold, no waiting. A **soft bounce** (`type: "blocked"`) is recorded but never suppresses. A spam report suppresses like an unsubscribe.\n\nAlways returns 200: a provider retries on non-2xx, but an event we can\'t match will never fix itself on retry.\n\n**Use this to simulate bounces without a real provider.**',
    tables: 'WRITE lead_engagements, client_leads.',
    body: [{ event: 'bounce', type: 'bounce', token: 'paste a trackingToken', reason: '550 no such user' }]
  },

  // ---- SEQUENCE (the outreach motion = the client's commercial unit) ----
  'POST /api/v1/sequences': {
    summary: 'Create a sequence (an outreach motion)',
    desc: 'A sequence is what the client actually contracts for: a multi-step motion against one lead list. Pricing lives HERE, not on the individual steps, so a 3-step cadence bills once rather than three times.',
    tables: 'READ clients, lead_lists; WRITE sequences.',
    body: { clientId: '<id>', leadListId: '<id>', name: 'Q3 Outbound Motion', description: 'Email then call', pricingModel: 'cost_per_lead', ratePerLead: 10 }
  },
  'GET /api/v1/sequences': {
    summary: 'List sequences (outreach motions)', desc: 'Includes a step count per sequence.',
    tables: 'READ clients, sequences, campaigns.',
    query: [{ name: 'clientId', desc: 'Restrict to one client' }]
  },
  'GET /api/v1/sequences/:id': {
    summary: 'Sequence rollup — steps, deduplicated totals, billing',
    desc: 'Unique leads reached (a person touched by 3 steps counts ONCE), conversions attributed per step, and one amount owed for the whole motion.',
    tables: 'READ sequences, campaigns, campaign_leads, lead_engagements, call_remarks, sequence_conversions.'
  },
  'PATCH /api/v1/sequences/:id': { summary: 'Edit a sequence', desc: 'Name, description, pricing. Pricing fields must stay coherent after the merge.', tables: 'WRITE sequences.', body: { ratePerLead: 12 } },

  // ---- REPORTS ----
  'GET /api/v1/reports/campaigns/:campaignId/pdf': { summary: 'Campaign PDF report', desc: 'Role-aware: a client gets a redacted copy (identities only for Qualified/Converted).', tables: 'READ campaigns, campaign_leads, leads, lead_engagements/call_remarks, lead_list_memberships.' },
  'GET /api/v1/reports/campaigns/:campaignId/excel': { summary: 'Campaign Excel report', desc: 'Lead-level sheet + summary sheet. Same role-aware redaction.', tables: 'as PDF.' },
  'GET /api/v1/reports/sequences/:sequenceId/pdf': {
    summary: 'Sequence PDF report (client-facing deliverable)',
    desc: 'The whole motion as one document: deduplicated totals, one amount owed, and the step-by-step breakdown. Contains NO lead identities by design — per-lead detail lives in the per-campaign reports. Accessible to the owning manager and to that client\'s portal users.',
    tables: 'READ sequences, campaigns, campaign_leads, lead_engagements, call_remarks, sequence_conversions, clients.'
  },
  'GET /api/v1/reports/sequences/:sequenceId/excel': {
    summary: 'Sequence Excel report',
    desc: 'Sheet 1: the steps and conversions at each. Sheet 2: summary and billing.',
    tables: 'as the sequence PDF.'
  },
  'GET /api/v1/reports/campaigns/:campaignId': { summary: 'Report data as JSON', desc: 'The same figures the PDF/Excel are built from.', tables: 'as PDF.' },

  // ---- PORTAL (client role) ----
  'GET /api/v1/portal/dashboard': {
    summary: '[Client] Aggregate dashboard',
    desc: 'Counts across all their non-draft campaigns (a manager\'s unfinished work is never shown). Full numbers; no lead identities. Qualified/Converted counts match exactly what the client can open. Reports both raw event counts (emailsSent, callsLogged) and unique-lead variants (emailsSentToUniqueLeads, uniqueLeadsCalled) side by side, so "40 calls" is never ambiguous between 40 companies and 10 called 4 times each. Optionally scoped with leadListId or sequenceId.',
    tables: 'READ clients, campaigns, campaign_leads, lead_engagements, call_remarks, lead_list_memberships, lead_lists, sequences.',
    query: [
      { name: 'leadListId', desc: 'Scope every number to one product/list — spans every sequence run against it' },
      { name: 'sequenceId', desc: 'Scope every number to one motion only' }
    ]
  },
  'GET /api/v1/portal/sequences': {
    summary: '[Client] Their outreach motions',
    desc: 'Each with deduplicated totals, the VISIBLE steps that made it up (draft steps are hidden entirely), conversions per step split into newConversions (billable) vs engagementEvents (raw), and ONE billing figure for the motion. A sequence with nothing but draft steps is omitted entirely. No lead identities. Each step carries its own campaignId for drilling into GET /reports/campaigns/{id}.',
    tables: 'READ clients, sequences, campaigns, campaign_leads, lead_engagements, call_remarks, sequence_conversions.'
  },
  'GET /api/v1/portal/sequences/:id': { summary: '[Client] One motion in detail', desc: 'Same draft-hiding as the list. Scoped to their own clientId — another client\'s sequence, or one with no visible steps yet, is simply not found.', tables: 'as portal/sequences.' },
  'GET /api/v1/portal/campaigns': { summary: '[Client] Campaign history', desc: 'Status, type, audience size, and whether each is a sequence step or standalone. Draft campaigns are excluded. No identities.', tables: 'READ clients, campaigns, campaign_leads.' },
  'GET /api/v1/portal/billing': {
    summary: '[Client] Billing statement — everything owed, grouped by pricing model',
    desc: 'Every priced sequence AND every priced standalone campaign, grouped into costPerLead / flatRetainer / unpriced. Each group has its own subtotal; the two priced groups are NEVER summed together — a cost-per-lead accrual and a flat retainer fee are different kinds of commitment, and blending them would produce a number matching no real invoice. Unlike the dashboard/sequence views, a priced unit with zero activity still appears here (a signed commitment is a financial fact even before work starts).',
    tables: 'READ clients, sequences, campaigns, campaign_leads, lead_engagements, call_remarks, sequence_conversions.'
  },

  // ---- UPLOAD (banner) ----
  'POST /api/v1/uploads/banner-url': {
    summary: 'Get a presigned banner upload URL',
    desc: 'Step 1 of 2. Validates ownership, email-only, draft-only, type and size, THEN issues a presigned PUT URL. Step 2: the browser PUTs the file straight to that URL (never through this API).\n\nUse the returned `publicUrl` as `bannerImageUrl` when you PATCH the campaign.',
    tables: 'READ campaigns, clients.',
    body: { campaignId: 'paste a DRAFT email campaign id', contentType: 'image/png', fileSize: 20480 }
  },
  'PUT /api/v1/uploads/local': {
    summary: '[Local driver] Receive the direct upload (step 2)',
    desc: 'Stand-in for a direct-to-S3 PUT when `STORAGE_DRIVER=local`. Send the raw image bytes as the body with `Content-Type: image/png` (or image/jpeg).\n\n**Swagger cannot send a raw binary body well — test this step with curl instead:**\n```\ncurl -X PUT "http://localhost:4000/api/v1/uploads/local?key=<key from step 1>" -H "Content-Type: image/png" --data-binary "@banner.png"\n```',
    tables: 'storage.',
    query: [{ name: 'key', required: true, desc: 'The key returned by POST /uploads/banner-url', example: 'images/<campaignId>/<uuid>.png' }]
  },
  'GET /api/v1/uploads/local': {
    summary: '[Local driver] Serve an uploaded image',
    desc: 'Open the returned `publicUrl` in a browser to confirm the banner uploaded correctly.',
    tables: 'storage.',
    query: [{ name: 'key', required: true, desc: 'The storage key', example: 'images/<campaignId>/<uuid>.png' }]
  }
};

function buildParameters(routePath, doc)
{
  const params = [];

  // Path params, derived from the route itself so they can never drift.
  (routePath.match(/:([a-zA-Z]+)/g) || []).forEach((m) =>
  {
    const name = m.slice(1);
    params.push({
      name,
      in: 'path',
      required: true,
      schema: { type: 'string' },
      description: (doc.pathDesc && doc.pathDesc[name]) || undefined,
      example: (doc.pathExample && doc.pathExample[name]) || undefined
    });
  });

  // Query params, declared per endpoint in DOCS.
  (doc.query || []).forEach((q) =>
  {
    params.push({
      name: q.name,
      in: 'query',
      required: Boolean(q.required),
      schema: q.enum ? { type: q.type || 'string', enum: q.enum } : { type: q.type || 'string' },
      description: q.desc,
      example: q.example
    });
  });

  return params;
}

/**
 * Turns a plain example object into a typed schema so Swagger renders an
 * editable form rather than one opaque textarea. Types are inferred from the
 * example values, which keeps the DOCS entries readable.
 */
function schemaFromExample(example)
{
  const properties = {};
  Object.entries(example).forEach(([key, value]) =>
  {
    if (Array.isArray(value))
    {
      properties[key] = { type: 'array', items: { type: typeof value[0] === 'object' ? 'object' : typeof value[0] || 'string' } };
    } else if (value !== null && typeof value === 'object')
    {
      properties[key] = { type: 'object' };
    } else
    {
      properties[key] = { type: typeof value === 'number' ? 'number' : typeof value === 'boolean' ? 'boolean' : 'string' };
    }
  });
  return { type: 'object', properties };
}

function buildOpenApiSpec()
{
  const paths = {};

  routes.forEach((route) =>
  {
    const key = `${route.method} ${route.path}`;
    const doc = DOCS[key] || {};
    // OpenAPI path params use {id}; our config uses :id
    const oaPath = route.path.replace(/:([a-zA-Z]+)/g, '{$1}');
    const method = route.method.toLowerCase();

    const needsAuth = (route.middlewares || []).includes('authenticate');
    const roleGuard = (route.middlewares || []).find((m) => m.startsWith('require'));

    const operation = {
      tags: [route.controller],
      summary: doc.summary || route.action,
      description:
        (doc.desc ? doc.desc + '\n\n' : '') +
        (doc.tables ? `**Tables:** ${doc.tables}\n\n` : '') +
        (roleGuard ? `**Access:** ${roleGuard.replace('require', '')}\n\n` : needsAuth ? '**Access:** any authenticated user\n\n' : '**Access:** public\n\n') +
        (doc.note ? `_${doc.note}_` : ''),
      parameters: buildParameters(route.path, doc),
      responses: { 200: { description: 'Success' }, 400: { description: 'Validation error' }, 401: { description: 'Unauthenticated' }, 403: { description: 'Forbidden' }, 404: { description: 'Not found' } }
    };

    if (needsAuth) operation.security = [{ bearerAuth: [] }];

    if (doc.multipart)
    {
      // File uploads must be declared as multipart/form-data with a binary
      // field, otherwise Swagger renders a text box and the upload fails.
      const props = {};
      Object.entries(doc.multipart).forEach(([field, spec]) =>
      {
        props[field] = spec.file
          ? { type: 'string', format: 'binary', description: spec.desc }
          : { type: spec.type || 'string', description: spec.desc, example: spec.example };
      });
      operation.requestBody = {
        required: true,
        content: {
          'multipart/form-data': {
            schema: { type: 'object', properties: props, required: doc.multipartRequired || [] }
          }
        }
      };
    } else if (doc.body)
    {
      const isArray = Array.isArray(doc.body);
      operation.requestBody = {
        required: true,
        content: {
          'application/json': {
            schema: isArray
              ? { type: 'array', items: schemaFromExample(doc.body[0] || {}) }
              : schemaFromExample(doc.body),
            example: doc.body
          }
        }
      };
    }

    paths[oaPath] = paths[oaPath] || {};
    paths[oaPath][method] = operation;
  });

  return {
    openapi: '3.0.0',
    info: {
      title: 'LeadPulse API',
      version: '1.0.0',
      description:
        'B2B outbound lead-generation platform. Endpoints are grouped by domain and tagged with the ' +
        'database tables each one touches. Authenticate via POST /auth/login, then click **Authorize** ' +
        'and paste the accessToken.'
    },
    servers: [{ url: SERVER }],
    components: {
      securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' } }
    },
    tags: [
      { name: 'auth' }, { name: 'client' }, { name: 'user' }, { name: 'leadList' },
      { name: 'lead' }, { name: 'campaign' }, { name: 'call' }, { name: 'email' },
      { name: 'report' }, { name: 'portal' }, { name: 'upload' }
    ],
    paths
  };
}

module.exports = { buildOpenApiSpec };