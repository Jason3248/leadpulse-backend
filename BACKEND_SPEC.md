# LeadPulse — Backend System & Architecture Specification

**Scope:** Backend only. No frontend/UI code, client-side setup, or design discussion is included.

---

## 1. Core Backend Overview

LeadPulse is a B2B outbound lead-generation and campaign management platform for an agency running email and call campaigns on behalf of multiple clients. Three roles exist: **Campaign Manager** (agency staff; owns clients, campaigns, executives), **Executive** (agency staff; works call/email campaigns), and **Client** (read-only portal user, scoped to exactly one client).

**Core objectives:**
- Import and deduplicate leads per client while keeping one global identity per real person across the whole agency.
- Run campaigns (single-channel) or **sequences** (multi-step, multi-channel motions) against a lead list.
- Track engagement (opens, clicks, conversions) and call outcomes, with a manager confirmation gate before any self-reported outcome counts toward billing.
- Generate redacted, role-aware reports and expose a read-only client portal.
- Bill per sequence (or per standalone campaign) — never per individual send/call.

### Tech Stack

| Layer | Choice |
|---|---|
| Runtime | Node.js |
| Web framework | Express 5 |
| ORM | Sequelize (Postgres dialect) |
| Database | PostgreSQL |
| Validation | Zod |
| Auth | JWT (access + refresh) + bcrypt |
| Logging | Winston |
| API docs | Custom OpenAPI 3.0 generator built directly from the route config (not hand-written), served via `swagger-ui-express` |
| PDF generation | PDFKit *(not Puppeteer — see §2)* |
| Excel generation | ExcelJS |
| Email delivery | SendGrid (`@sendgrid/mail`) — stub mode (logs instead of sending) when unconfigured |
| Bot verification | Google reCAPTCHA v3 — stub mode (skipped) when unconfigured |
| File parsing | `csv-parse`, `xlsx` |
| Rate limiting | `express-rate-limit` |
| Security headers | `helmet` |
| Object storage | Local filesystem by default; AWS S3 via `STORAGE_DRIVER=s3` env var, zero code change |

### Architecture

npm-workspaces monorepo, four packages:

```
leadpulse-api/              Core REST API — port 4000, 83 routes
leadpulse-upload-service/   Async CSV/XLSX import worker — port 4001
leadpulse-email-service/    SendGrid dispatch wrapper — port 4002
leadpulse-data-model/       Shared Sequelize models + migrations (workspace dependency of the other three)
```

There is **no message broker** (no SQS/BullMQ/Redis). Asynchronous work (imports, email dispatch) is modeled as **database-backed job rows** (`import_jobs`, `email_dispatch_jobs`) that the caller polls; the actual work is triggered by a direct in-process/internal-HTTP call to the relevant microservice. This is a known, deliberate simplification — see §7.

### Testing

No Jest/Mocha — a custom lightweight assertion runner (`check(label, condition, extra)`) per suite. Each suite spawns real service processes and exercises them over real HTTP against a real (disposable, migrated-per-run) Postgres database — no mocking of the database or HTTP layer. **12 suites, 484 assertions total**, verified stable across repeated consecutive full runs. See §6 for the full breakdown.

---

## 2. Extended Scope vs. SRS

Two SRS documents existed (`LeadPulse_SRS_Nexsales.pdf` — original, and `LeadPulse_SRS_Updated_Microservices_AWS.docx` — updated). The following are **deliberate, agreed decisions** where the implementation goes beyond, diverges from, or fills gaps left by both.

1. **Multi-executive campaigns.** SRS 4.2.2 states only one Executive may be assigned to a campaign at a time. Implemented as many-to-many (`campaign_executives`) with round-robin lead distribution across all active assignees at approval time — a single executive cannot realistically work a large campaign alone.

2. **Sequences — a new entity, not in either SRS.** A client contracts for a *motion* (e.g. "email, then a follow-up call"), not per-channel-touch. `sequences` is the commercial unit; campaigns optionally attach via `sequence_id` + `sequence_step_order`. Pricing lives on the sequence (or on a standalone campaign that has no sequence); a sequence-linked campaign's own pricing fields are never populated — its analytics report `{ billedAtSequenceLevel: true, sequenceId, sequenceName }` instead of a number, so the same money is never implied twice.

3. **`sequence_conversions` ledger with a database-enforced billing guarantee.** `UNIQUE(sequence_id, lead_id)` makes "billed once per lead per sequence" a structural fact, not application logic. The same lead converting in a *different* sequence is billed again, correctly — the constraint is scoped per sequence, not globally per lead.

4. **Three-tier lead identity model**, more granular than either SRS describes:
   - `leads` — one global row per real person (unique by email), agency-wide.
   - `client_leads` — per **(client, lead)** consent/suppression: DNC, unsubscribed, hard-bounced.
   - `lead_list_memberships` — per **(list, lead)** funnel status (`New→Contacted→Qualified→Converted`, or `Dead`).
   The same real person can be `Converted` on one client's list and `New` elsewhere — client A never learns anything about client B's relationship with a shared contact.

5. **Forward-only status guard with a manual override escape hatch.** Automatic transitions (from clicks/call outcomes) only ever move status forward, or to `Dead` on an explicit negative signal. Only a Manager's explicit `isManualOverride: true` may move status in any direction, correcting a mistake.

6. **Manager confirmation gate on call-reported conversions — not specified in either SRS.** A "Converted" call outcome does not count immediately: `conversion_confirmed` starts `NULL` and requires `PATCH /call/remarks/:id/review` by a Manager. The reporting Executive can never be the confirming Manager (DB `CHECK` constraint). Only confirmation flips the lead's status and writes the sequence ledger row. Every client-facing view shows `Qualified`, never `Converted`, until confirmed.

7. **Two-step GET/POST split on every lead-facing tracking link** (`/track/convert`, `/track/unsubscribe`). GET only renders a confirmation page and writes nothing; only POST acts. This defeats corporate mail-scanner link-prefetching (e.g. Microsoft Safe Links) from silently manufacturing false conversions or unsubscribes.

8. **Live contactability re-check at serve time**, not just at audience-freeze time. `GET /call/campaigns/:id/next` re-checks DNC/unsubscribed/hard-bounced/closed-status live against current data, retiring (never deleting) a lead that became uncontactable after the campaign was already approved.

9. **Queue ordering — evolved through three iterations, each fixing a real, previously-shipped bug:**
   - v1 (`addedAt ASC` only) → a "sticky lead" bug: the same unreachable lead was re-served immediately after every "Not Answered."
   - v2 (`lastWorkedAt ASC NULLS FIRST, addedAt ASC` — least-recently-worked-first) → fixed the sticky bug, but non-deterministic on an exact tie (e.g. two leads bulk-imported in the same millisecond).
   - v3 (current) — added `id ASC` as a guaranteed-unique final tiebreaker, and folded a "skip" timestamp into the same ordering signal via `GREATEST(lastWorkedAt, last_skipped_at)`.
   A scheduled callback (`in_progress`, from "Callback Requested") is additionally excluded from `/next` until its `follow_up_date` is today or earlier.

10. **"Skip" action (`POST /call/leads/:id/skip`) — closes a real gap.** Previously, the only way to move past a lead was to log one of the fixed call outcomes, forcing an Executive to fabricate e.g. "Not Answered" for a call that never happened just to advance the queue — corrupting call history and inflating logged-call stats. `skip` writes **zero** `call_remarks` rows; it only stamps `last_skipped_at`, which ordering treats identically to a genuine attempt.

11. **`GET /call/leads/:id` (lead detail by id) — closes a related gap.** `callbacks-due` only returns a reduced summary (no remark history, missing several fields); this endpoint returns the full card for one known lead, purely read-only, no side effects.

12. **Role-agnostic self-service `PATCH /auth/change-password` and `PATCH /auth/profile`.** The SRS only explicitly describes this for the Client Portal and implies it for Executives ("first-login password-change prompt") without ever specifying an endpoint. Previously the *only* way to change a password was the full forgot/reset-via-email round trip. `change-password` requires the current password and invalidates every other session (bumps `token_version`); available identically to all three roles.

13. **reCAPTCHA v3 in stub mode.** Fully implemented per the SRS (Google `siteverify`, 0.5 minimum score, fail-**closed** on a provider outage — reported as `503`, distinct from a failed check's `400`) but entirely gated behind `RECAPTCHA_SECRET_KEY`. Unconfigured (the default — no real Google site key exists yet), verification is skipped and every auth flow works unmodified. Mirrors the SendGrid stub-mode pattern exactly.

14. **PDFKit instead of Puppeteer** (SRS 4.9.1 names Puppeteer) — an explicit, agreed substitution. Puppeteer requires a full headless Chromium for a template-driven, single-column report; PDFKit draws the same content directly and far more cheaply.

15. **`segmentationFilters` (JSONB) + `excludeClosedLeads`**, resolved fresh at **approval time only**, never re-evaluated after freeze. A later sequence step's filters can deliberately re-target leads an earlier step excluded (e.g. `excludeClosedLeads: false` for a win-back/thank-you step).

16. **Report/portal redaction, governed by one shared constant.** Full aggregate counts are always shown (proof of work); individual lead identity is redacted to `(withheld)` unless that lead's per-list status is `Qualified` or `Converted`. Internal call notes are **never** shown to a client regardless of status. One constant (`CLIENT_VISIBLE_STATUSES`) governs every redaction decision, so the portal, sequence rollups, and campaign reports can never disagree with each other.

17. **`GET /portal/billing` — a dedicated billing statement, not in either SRS.** Groups every priced sequence and every priced standalone campaign into `costPerLead` / `flatRetainer` / `unpriced`, each with its own subtotal. The two priced groups are **deliberately never summed** — a per-conversion accrual and a fixed retainer fee are not the same kind of number, and blending them would produce a figure matching no real invoice. Unlike every other client-facing view, a priced-but-inactive unit (a signed retainer with zero campaigns run yet) still appears here — a financial commitment is real before any activity exists.

18. **Draft-work invisibility to the client portal.** A Manager's unapproved campaign, or a sequence whose only steps are still draft, never appears in any client-facing endpoint. Since `approve` is a one-directional transition, nothing that becomes visible can later become invisible again mid-flight.

19. **Aggregate scoping** — `?clientId=` on the Manager dashboard, `?leadListId=`/`?sequenceId=` on the Client dashboard — lets a blended aggregate be narrowed on demand. Motivated by a real ambiguity: the same lead converting through two independent sequences shows as **one** unique person in an unscoped `convertedLeads` count, but as **two** separately-billed line items in `/portal/billing`. Both are correct; scoping lets the two be reconciled.

20. **Weighted, not naive-averaged, aggregate rates.** `avgEmailOpenRate` on the Manager dashboard is `Σopens / Σsent` across every campaign in scope, not an average of each campaign's own rate — otherwise one small campaign's fluke 100% open rate would outweigh a large campaign's real 20%. Verified by deliberately reverting to a naive average in testing and confirming a detectably different (wrong) result.

21. **`GET /manager/dashboard` — a new aggregate endpoint.** The SRS describes the screen (4.8.1) but the natural REST decomposition (campaign list + N per-campaign analytics calls) doesn't scale; built as one efficient call, mirroring the client portal's own dashboard design.

22. **Atomic double-send guard on email dispatch** — a conditional `UPDATE ... WHERE dispatch_status = 'not_sent'` guarantees exactly one dispatch job ever wins for a campaign, even under a race (e.g. a double-click).

23. **Stale-job rescue.** Both `import_jobs` and `email_dispatch_jobs` stuck in `processing` past 30 minutes (e.g. a worker crash) are lazily transitioned to `failed` the next time their status is read — no separate scheduler needed.

24. **Bounce classification by SendGrid's `type` field, not a numeric threshold.** Anything not explicitly `"blocked"` (SendGrid's soft-bounce marker) is treated as hard and immediately suppresses that `(client, lead)` pair — erring toward suppression as the safer default for sender reputation.

---

## 3. Database Schema & Data Models

PostgreSQL, 15 tables, 21 migrations, all Sequelize models use `underscored: true` (camelCase in code, snake_case in the DB) and UUID primary keys (`gen_random_uuid()` / `UUIDV4`).

### Entity Relationship Summary

```
users (self-ref: manager_id) ──< clients ──< lead_lists ──< lead_list_memberships >── leads >── client_leads >── clients
  │                                │              │
  │                                │              └──< campaigns >── sequences ──< sequence_conversions
  │                                └──< sequences
  │
  ├──< campaign_executives >── campaigns
  ├──< campaign_leads >── campaigns, leads
  │        ├──< lead_engagements   (email tracking, 1:1 per campaign_lead)
  │        └──< call_remarks        (call history, 1:many per campaign_lead)
  │
  ├──< import_jobs >── clients, lead_lists
  └──< email_dispatch_jobs >── campaigns
```

### Tables

**`users`**
| Field | Type | Notes |
|---|---|---|
| id | UUID PK | |
| role | ENUM('campaign_manager','executive','client') | |
| manager_id | UUID, FK→users, nullable | self-referential; owner for executives/clients |
| client_id | UUID, FK→clients, nullable | only set for `client` role |
| first_name, last_name | STRING(50) | |
| email | STRING(255) | **UNIQUE** |
| password_hash | STRING(255) | bcrypt |
| token_version | INTEGER, default 1 | bumped to instantly revoke all outstanding access tokens |
| refresh_token_hash, refresh_token_expires_at | nullable | hashed at rest; single active refresh token per user |
| reset_token_hash, reset_token_expires_at | nullable | password-reset flow |
| failed_login_attempts, locked_until | | lockout after repeated failures |
| is_active | BOOLEAN default true | |
| last_login_at | nullable | |

Indexes: `manager_id`, `role`, `client_id`.

**`clients`** — id, `manager_id` (FK→users), name, contact_person, contact_email, is_active. Index: `manager_id`.

**`leads`** (global) — id, first_name, last_name, `email` **UNIQUE**, phone, company, job_title, industry, source.

**`client_leads`** — id, client_id, lead_id, dnc, is_unsubscribed, is_hard_bounced. **UNIQUE(client_id, lead_id)**. Index: `lead_id`.

**`lead_lists`** — id, client_id, name, status ENUM('active','archived'), imported_by_user_id. **UNIQUE(client_id, lower(name))**. Index: `client_id`.

**`lead_list_memberships`** — id, lead_list_id, lead_id, status ENUM('New','Contacted','Qualified','Converted','Dead'), added_at. **UNIQUE(lead_list_id, lead_id)**. Indexes: `lead_id`, `status`.

**`sequences`** — id, client_id, lead_list_id (nullable), name, description, pricing_model ENUM('flat_retainer','cost_per_lead'), retainer_amount, rate_per_lead, created_by_user_id. Index: `client_id`.
CHECKs: `chk_sequences_pricing_fields` (exactly one of retainer/rate populated matching the model, or neither), `chk_sequences_amounts_nonnegative`.

**`sequence_conversions`** — id, sequence_id, lead_id, campaign_id, channel ENUM('email','call'), converted_at. **UNIQUE(sequence_id, lead_id)** — the structural once-per-sequence billing guarantee. Index: `sequence_id`.

**`campaigns`** — id, client_id, lead_list_id, sequence_id (nullable), sequence_step_order (nullable), created_by_user_id, name, type ENUM('email','call'), description, category_tag, status ENUM('draft','active','paused','completed'), dispatch_status ENUM('not_sent','sending','sent'), segmentation_filters JSONB, exclude_closed_leads BOOLEAN default true, pricing_model, retainer_amount, rate_per_lead, requires_manager_approval, approved_by_user_id, approved_at, subject_line, sender_name, reply_to_email, email_body_html, banner_image_url, schedule_type, scheduled_at. Indexes: `client_id`, `lead_list_id`, `sequence_id`, `status`.
CHECKs: `chk_campaigns_pricing_fields`, `chk_campaigns_amounts_nonnegative`.

**`campaign_executives`** — id, campaign_id, executive_user_id, is_active, unassigned_at. Partial **UNIQUE(campaign_id, executive_user_id) WHERE is_active** — soft-close on reassignment, history preserved. Index: `campaign_id`.

**`campaign_leads`** — id, campaign_id, lead_id, assigned_executive_id (nullable), queue_status ENUM('pending','in_progress','called','skipped','completed'), `last_skipped_at` (added in migration 21), added_at. **UNIQUE(campaign_id, lead_id)**. Indexes: `campaign_id`, `assigned_executive_id`.

**`lead_engagements`** — id, campaign_lead_id, `tracking_token` STRING(64) **UNIQUE**, status ENUM('sent','delivered','bounced','spamreport'), sent_at, delivered_at, opened_at, clicked_at, converted_at, unsubscribed_at, open_count, click_count, bounce_type ENUM('hard','soft'), error_message. Index: `campaign_lead_id`.

**`call_remarks`** — id, campaign_lead_id, executive_user_id, call_outcome ENUM('Answered','Not Answered','Busy','Wrong Number','Left Voicemail','Callback Requested','Not Interested','Converted'), call_duration_minutes, notes, follow_up_date DATEONLY, lead_status_update ENUM(same as membership status), is_manual_entry_by_manager, conversion_confirmed (nullable BOOLEAN), conversion_rejection_reason, confirmed_by_user_id, confirmed_at. Index: `campaign_lead_id`.
CHECKs: `chk_call_remarks_no_self_confirm` (confirmed_by_user_id ≠ executive_user_id), a follow-up-date-required-iff-Callback-Requested check, `call_duration_minutes >= 0`.

**`import_jobs`** — id, client_id, lead_list_id (nullable until resolved), lead_list_name, started_by_user_id, original_filename, source_file_key, error_file_key, status ENUM('uploaded','queued','processing','completed','completed_with_errors','failed'), total_rows, processed_rows, successful_rows, failed_rows, new_to_agency, matched_from_agency_database, already_mapped_to_client, failure_reason, started_at, finished_at. Indexes: `client_id`, `status`.
CHECK: `chk_import_jobs_counts_sane` (all counters ≥ 0, parts never exceed the whole).

**`email_dispatch_jobs`** — id, campaign_id, started_by_user_id, status (same enum shape as import jobs), total_recipients, processed, sent, failed, suppressed, failure_reason, started_at, finished_at. Indexes: `campaign_id`, `status`.
CHECK: `chk_email_jobs_counts_sane`.

---

## 4. API Endpoints & Integration Contracts

Base path: `/api/v1`. 83 routes. Roles shown are the enforcing middleware; several endpoints additionally check resource ownership beyond role alone.

### Auth (public except where noted)
| Method | Path | Notes |
|---|---|---|
| POST | `/auth/register` | Self-service, Manager only. Rate-limited. |
| POST | `/auth/login` | Rate-limited. 5 failed attempts → 15-min lockout. |
| POST | `/auth/refresh` | Reads httpOnly refresh cookie, rotates it. |
| POST | `/auth/logout` | Auth required. Revokes refresh token + bumps `token_version`. |
| POST | `/auth/forgot-password` | Rate-limited. Identical response whether or not the email exists. |
| POST | `/auth/reset-password` | Rate-limited. Bumps `token_version` (all sessions invalidated). |
| GET | `/auth/me` | Auth required. |
| PATCH | `/auth/change-password` | Auth required, any role. Requires current password. |
| PATCH | `/auth/profile` | Auth required, any role. Display name only. |

### Clients (Manager)
`POST /clients`, `GET /clients`, `GET /clients/:id` *(also reachable by that client's own portal user)*, `PATCH /clients/:id`, `PATCH /clients/:id/deactivate`, `PATCH /clients/:id/reactivate`.

### Team & Client Portal Users (Manager)
`POST /users/executives`, `GET /users/executives`, `POST /users/client-users`, `GET /users/client-users`, `PATCH /users/:id/deactivate`, `PATCH /users/:id/reactivate`, `POST /users/:id/reset-password`.

### Lead Lists & Import (Manager)
`POST /lead-lists`, `GET /lead-lists`, `GET /lead-lists/:id`, `PATCH /lead-lists/:id/archive`, `POST /leads/import` *(multipart, async — 202 + job id)*, `GET /leads/imports`, `GET /leads/imports/:jobId/status`, `GET /leads/imports/:jobId/errors`.

### Leads (Manager)
`GET /leads`, `GET /leads/:id`, `PATCH /leads/:id/dnc`, `PATCH /leads/:id/status`.

### Campaigns (Manager)
`POST /campaigns`, `GET /campaigns`, `GET /campaigns/:id`, `PATCH /campaigns/:id` *(draft only)*, `POST /campaigns/:id/executives`, `DELETE /campaigns/:id/executives/:executiveId`, `POST /campaigns/:id/reassign-leads`, `PATCH /campaigns/:id/approve` *(freezes the audience — the single most important transition)*, `PATCH /campaigns/:id/pause`, `PATCH /campaigns/:id/resume`, `PATCH /campaigns/:id/end`.

Example creation payload:
```json
POST /campaigns
{
  "clientId": "uuid", "leadListId": "uuid", "name": "Q3 Calls", "type": "call",
  "segmentationFilters": { "industry": "Tech", "membershipStatus": "New" },
  "excludeClosedLeads": true,
  "pricingModel": "cost_per_lead", "ratePerLead": 8,
  "sequenceId": "uuid", "sequenceStepOrder": 2
}
```

### Call Engine
| Method | Path | Role |
|---|---|---|
| GET | `/call/my-campaigns` | Executive |
| GET | `/call/campaigns/:campaignId/next` | Executive |
| POST | `/call/leads/:campaignLeadId/remarks` | Executive |
| POST | `/call/leads/:campaignLeadId/skip` | Executive |
| GET | `/call/leads/:campaignLeadId` | Executive |
| GET | `/call/campaigns/:campaignId/callbacks-due` | Manager or Executive |
| GET | `/call/campaigns/:campaignId/pending-conversions` | Manager |
| PATCH | `/call/remarks/:remarkId/review` | Manager |
| GET | `/call/campaigns/:campaignId/progress` | Manager |

Remark payload: `{ "callOutcome": "Callback Requested", "callDurationMinutes": 3, "notes": "...", "followUpDate": "2026-02-01" }`. Review payload: `{ "confirmed": true }` or `{ "confirmed": false, "rejectionReason": "..." }`.

### Email Engine
`POST /email/campaigns/:campaignId/dispatch` (Manager or Executive, async — 202), `GET /email/dispatches/:jobId`, `GET /email/campaigns/:campaignId/dispatches`, `GET /email/campaigns/:campaignId/analytics` (Manager).

### Tracking (public, unauthenticated by design)
`GET /track/open`, `GET /track/click`, `GET|POST /track/convert` (GET renders only, POST acts), `GET|POST /track/unsubscribe` (same split), `POST /webhooks/sendgrid` (array of provider events; always returns 200).

### Reports
`GET /reports/campaigns/:campaignId/{pdf,excel}`, `GET /reports/campaigns/:campaignId` (JSON), `GET /reports/sequences/:sequenceId/{pdf,excel}` — all auth-required, role-aware redaction applied server-side (Manager sees everything; Client sees redacted).

### Client Portal (Client role)
`GET /portal/dashboard?leadListId=&sequenceId=`, `GET /portal/campaigns`, `GET /portal/sequences`, `GET /portal/sequences/:id`, `GET /portal/billing`.

### Sequences (Manager)
`POST /sequences`, `GET /sequences?clientId=`, `GET /sequences/:id` (full rollup), `PATCH /sequences/:id`.

### Uploads (banner images)
`POST /uploads/banner-url` (Manager — issues a presigned URL), `PUT /uploads/local`, `GET /uploads/local` (local-storage-driver stand-in for a direct-to-S3 PUT).

### Manager Dashboard
`GET /manager/dashboard?clientId=` — KPI aggregate (see §2.21).

---

## 5. Third-Party Services & Authentication

| Service | Purpose | Behavior when unconfigured |
|---|---|---|
| **SendGrid** (`@sendgrid/mail`) | Transactional + campaign email delivery | Stub mode — logs the payload instead of sending. Switching to real delivery is an env-var change only. |
| **Google reCAPTCHA v3** | Bot verification on register/login/reset-password | Stub mode — verification skipped entirely. `RECAPTCHA_VERIFY_URL` is itself overridable, enabling tests against a mock endpoint instead of Google's real one. |
| **AWS S3** (`@aws-sdk/client-s3`, presigner) | Banner image storage | Only active when `STORAGE_DRIVER=s3`; local filesystem driver is the default with an identical interface. |

### Authentication Pattern

- **Access token:** JWT, HS256, 15-minute expiry. Payload: `userId`, `role`, `tokenVersion`.
- **Refresh token:** 7-day expiry, delivered as an **httpOnly, SameSite=Strict** cookie; hashed at rest in `users.refresh_token_hash`; rotated on every use; one active refresh token per user.
- **Instant revocation:** `token_version` is bumped on logout, password change, password reset, and account deactivation — an already-issued access token is rejected immediately rather than waiting out its 15-minute natural expiry.
- **Password hashing:** bcrypt.
- **Authorization layering:** role middleware (`requireManager` / `requireExecutive` / `requireClient` / `requireManagerOrExecutive`) plus per-resource ownership assertions (e.g. `assertClientOwnership`) as defense in depth — role alone is never sufficient for anything that touches a specific client's data.
- **CORS:** configured for a credentialed cross-origin frontend (`credentials: true`, explicit origin allowlist via `CLIENT_ORIGIN` env var).

---

## 6. Current Implementation State

### Fully written, tested, and working (484 assertions, 12 suites, all passing across repeated full runs)

| Suite | Assertions | Covers |
|---|---|---|
| test-runner | 51 | Auth (register/login/lockout/forgot/reset), change-password, profile, DB constraint checks |
| test-campaign | 34 | Campaign CRUD, executive assignment, approval freeze, pricing constraints |
| test-import | 23 | Async CSV/XLSX import, error rows, stale-job rescue |
| test-call | 79 | Queue ordering (all 3 iterations' guarantees), remarks, skip, lead-detail-by-id, callbacks-due, conversion review, multi-campaign assignment |
| test-email | 54 | Async dispatch, double-send guard, tracking (open/click/convert/unsubscribe), SendGrid webhook, bounce/spam suppression |
| test-users | 31 | Executive/client-user creation, deactivation, password reset trigger |
| test-reports | 46 | PDF/Excel generation, role-aware redaction |
| test-portal | 22 | Client portal aggregates, redaction |
| test-banner | 15 | Presigned upload flow, validation guards |
| test-sequence | 97 | Sequence CRUD, billing ledger, cross-sequence billing, portal fixes, `/portal/billing` |
| test-recaptcha | 12 | Stub mode, enforced mode (mocked verify endpoint), fail-closed on provider outage |
| test-manager | 20 | Manager dashboard aggregate, weighted-rate math, client scoping, cross-manager isolation |

Every non-trivial fix in this system was verified via **deliberate break-then-restore testing** — the relevant guard was disabled, the test was confirmed to genuinely fail with the predicted wrong value, then the fix was restored and reconfirmed. This is not a claim of coverage; it is how each of the assertions above was produced.

### Partially built / stubbed by design

- **SendGrid & reCAPTCHA** — both fully implemented, both intentionally inert without real credentials (stub mode). Not a gap; a deliberate environment-driven switch.
- **Async job processing** — functionally complete and tested, but implemented as DB-polled job rows with in-process/direct-call execution rather than a true message-queue-backed worker (see §7, item 4).
- **SendGrid webhook endpoint** — functionally complete but has no signature verification (unauthenticated by design; acceptable for local/dev use only).

---

## 7. Immediate Tasks & Pending Backlog

In priority order:

1. **Sequence/campaign list-coherence validation.** Nothing currently prevents a campaign from being created with `sequenceId` set but a `leadListId` that diverges from that sequence's own declared list. Add a validation check at campaign-creation time that rejects this mismatch outright.

2. **"Same cohort as a prior step" audience targeting.** Each step's audience is currently resolved independently against the *live* list state at its own approval time — a lead added to the list after step 1 approves can be swept into step 2 if step 2's filters don't happen to exclude them, even though they were never part of step 1. Add an explicit targeting option (e.g. `segmentationFilters.onlyFromCampaignId`) that resolves against a named prior step's frozen `campaign_leads`, not the live list.

3. **Call queue retry cooldown.** No minimum time is enforced between repeated attempts on the same lead — a small queue can re-serve someone within minutes of a "Not Answered." Add a configurable cooldown window.

4. **Attempt-count cap / visibility.** No limit or surfaced count exists for how many times a lead has been attempted without resolution; add a counter and, eventually, a soft cap or manager-visible flag.

5. **Replace DB-polled job rows with a real queue** (SQS, BullMQ, or equivalent) for import processing and email dispatch, enabling genuine horizontal worker scaling instead of in-process/direct-call execution.

6. **SendGrid webhook signature verification.** Currently unauthenticated by design; add HMAC/signature validation before any deployment reachable from the public internet.

7. **Reassign-leads endpoint test coverage.** `POST /campaigns/:id/reassign-leads` exists and is wired, but has comparatively light dedicated test coverage relative to the rest of the call engine — worth a focused pass.

8. **Lead-level browse/detail surface.** `GET /leads/:id` exists and returns engagement + call-remark history correctly, but there is no dedicated reporting rollup for "every interaction with this one lead across every list/campaign" beyond what that single endpoint already returns — worth revisiting if deeper per-lead audit trails become a requirement.