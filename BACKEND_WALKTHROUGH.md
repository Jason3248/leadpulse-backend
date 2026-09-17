# LeadPulse — Backend Concept Breakdown & End-to-End Flow

This document explains the whole backend the way you'd present it: the flow a
frontend would drive, what every endpoint does, which tables it touches, what
each enum value means and when it changes, and the mechanics of the two things
that are easy to hand-wave but shouldn't be — **email engagement tracking** and
**call remarks**.

Pair this with the interactive docs at **`http://localhost:4000/api-docs`** once
the server is running: that lets you actually fire each call in order.

---

## 0. The mental model

LeadPulse is an **internal tool for one lead-generation agency**. The agency has
**Campaign Managers** (the main users). Each Manager onboards **Clients** (the
businesses the agency runs outreach for) and **Executives** (agency staff who
work phones and trigger sends). Leads are a **shared agency-wide database**; a
Client's *relationship* to a lead is separate from the lead itself.

Three roles, and every route is scoped by them:

| Role | Is | Can |
|---|---|---|
| `campaign_manager` | The tenant owner (self-registers) | Everything, scoped to their own data |
| `executive` | Agency staff, created by a Manager | Work assigned call queues, trigger assigned email sends |
| `client` | External, read-only, created by a Manager | See their own campaigns' results (redacted) |

Every piece of data traces back to a Manager via `manager_id`. That single
foreign key is the entire multi-tenancy boundary — no workspace table needed.

---

## 1. The two-tier lead model (why leads and client_leads are separate)

This is the single most important schema decision, so understand it first.

- **`leads`** = a global, agency-wide identity. One row per real person
  (unique by email). Name, phone, company, job title. No `client_id`.
- **`client_leads`** = the mapping that says "Client X has a relationship with
  person Y." This is where **consent** lives: `dnc`, `is_unsubscribed`,
  `is_hard_bounced`. Unique on `(client_id, lead_id)`.
- **`lead_list_memberships`** = "person Y is in list L, and their *status* in
  that list is S." Status is **per list**, not global.

**Why three tables for "a lead"?** Because the same real person can be:
- sourced once into the agency DB (one `leads` row),
- targeted by two different clients (two `client_leads` rows — and unsubscribing
  from Client A never silences Client B),
- at different funnel stages for two different products of the *same* client
  (two `lead_list_memberships` rows — Converted on Product A, still New on
  Product B).

A single "leads table with a status column" cannot represent that without
duplicating people or leaking one client's data into another's.

---

## 2. Enums — every value, what it means, when it changes

### `ROLES` — on `users.role`
`campaign_manager` | `executive` | `client`. Set at creation, never changes.

### `LEAD_LIST_STATUS` — on `lead_lists.status`
- `active` — usable as a campaign source.
- `archived` — retired. No **new** campaign can target it (existing ones are
  unaffected). Set by `PATCH /lead-lists/:id/archive`.

### `MEMBERSHIP_STATUS` — on `lead_list_memberships.status` (the lead funnel)
This is the heart of the business logic. Order matters:

- `New` — imported, never contacted. The starting state.
- `Contacted` — an attempt was made (email sent, or a call logged). Automatic.
- `Qualified` — a **genuine interest signal**. Email: they **clicked** a link.
  Call: an executive judged them interested and set it. This is the
  "MQL-equivalent" — worth pursuing.
- `Converted` — **delivered as a qualified prospect** (the "SQL-equivalent").
  Email: they clicked the dedicated "I'm interested" CTA. Call: an executive
  marked Converted **and a manager confirmed it**. This is the billable unit.
- `Dead` — an explicit negative. Call outcome "Not Interested", or a manager
  override. **Never** set automatically from email silence.

**The forward-only guard:** automatic events can only move status *forward*
(New→Contacted→Qualified→Converted) or to Dead on an explicit negative. A later
weak event (e.g. a re-call that goes unanswered) can **never demote** a lead who
already reached Qualified. Only a **manual** manager override
(`PATCH /leads/:id/status`) may move status any direction — to fix a mistake.
`MEMBERSHIP_STATUS_ORDER` is the ranked list that enforces this.

**Why status ≠ consent:** a lead can be `Qualified` AND unsubscribed at the same
time — they showed interest once, then asked to stop. Both facts are true and
independent. Consent (in `client_leads`) governs *whether we may contact*;
status governs *how interested they are*.

### `IMPORT_JOB_STATUS` — on `import_jobs.status`
`uploaded` → `queued` → `processing` → then one terminal state:
`completed` (all rows fine) | `completed_with_errors` (some rows skipped, error
CSV produced) | `failed` (the whole job died). A job stuck in `processing` past
30 min is auto-rescued to `failed` on the next status poll.

### `CAMPAIGN_TYPE` — on `campaigns.type`
`email` | `call`. Fixed at creation. Determines the entire execution path.

### `CAMPAIGN_STATUS` — on `campaigns.status` (lifecycle)
- `draft` — being built. Editable. Audience **not** frozen yet.
- `active` — approved and running. Audience is frozen. Set by `approve`.
- `paused` — temporarily halted (queue closed / dispatch blocked). Reversible.
- `completed` — terminal. Reached by ending early, or (call) by exhaustion, or
  (email) by the manager after sending.

### `DISPATCH_STATUS` — on `campaigns.dispatch_status` (email double-send guard)
- `not_sent` — never dispatched.
- `sending` — a dispatch is in flight. This is the **lock**: the trigger flips
  `not_sent → sending` atomically, so a second click (or a manager + executive
  at once) can't double-send.
- `sent` — dispatch finished. A failed run resets this to `not_sent` so it can
  be retried.

### `QUEUE_STATUS` — on `campaign_leads.queue_status` (call queue only; null for email)
- `pending` — never attempted.
- `in_progress` — has an open callback (a `Callback Requested` outcome). Stays
  workable; keeps the campaign open.
- `called` — attempted, no hard resolution yet (Not Answered/Busy/Voicemail).
  **Still re-servable** — the lead comes back around in the queue.
- `completed` — resolved (Converted / Not Interested / Wrong Number).
- `skipped` — pulled by the live consent check, or swept when a campaign ends
  early, or manually skipped.

A campaign auto-completes when **every** row is `completed` or `skipped`.

### `ENGAGEMENT_STATUS` — on `lead_engagements.status` (email delivery state)
- `sent` — handed to the provider (or attempted).
- `delivered` — provider confirmed delivery (via webhook).
- `bounced` — provider rejected it.
- `spamreport` — recipient marked it spam.

### `BOUNCE_TYPE` — on `lead_engagements.bounce_type`
- `hard` — permanent (bad address). **Immediately** sets
  `client_leads.is_hard_bounced = true`, suppressing that address for this
  client forever — no threshold, no waiting.
- `soft` — transient (mailbox full). Recorded, but does **not** suppress.

### `CALL_OUTCOME` — on `call_remarks.call_outcome`
`Answered` | `Not Answered` | `Busy` | `Wrong Number` | `Left Voicemail` |
`Callback Requested` | `Not Interested` | `Converted`. See §7 for exactly what
each does to the queue and to lead status.

### `PRICING_MODEL` — on `campaigns.pricing_model`
- `flat_retainer` — client pays a fixed `retainer_amount` regardless of outcome.
  The useful metric becomes "cost per conversion."
- `cost_per_lead` — client pays `rate_per_lead` per **confirmed** conversion.
  Spend accrues live. This is the model where the confirmation gate protects
  real money.
Mutually exclusive, enforced by a DB CHECK constraint.

---

## 3. The end-to-end flow (the order a frontend would drive)

### Phase A — Onboarding
1. `POST /auth/register` — Manager self-registers. → `users`
2. `POST /auth/login` — get the access token. Everything below carries it.
3. `POST /clients` — create "Acme Corp". → `clients`
4. `POST /users/executives` — create Raj & Priya. Temp passwords emailed. → `users`
5. `POST /users/client-users` — create Acme's read-only portal login. → `users`

### Phase B — Get leads in
6. `POST /leads/import` (multipart: clientId, leadListName, file) → returns a
   **job id** immediately (202). → `import_jobs`
7. `GET /leads/imports/:jobId/status` — poll until terminal. Behind the scenes
   the upload microservice parses the file; each row upserts into `leads`,
   creates a `client_leads` mapping if new to this client, and a
   `lead_list_memberships` row (status `New`). The summary distinguishes
   **newToAgency** / **matchedFromAgencyDatabase** / **alreadyMappedToThisClient**.
8. `GET /leads?clientId=...` — browse the imported leads.

### Phase C — Build a campaign
9. `POST /campaigns` — draft, type `call` or `email`, with segmentation filters
   and pricing. Audience is **not** frozen yet. → `campaigns`
10. (email) `PATCH /campaigns/:id` — set subject/sender/body; optionally
    `POST /uploads/banner-url` then attach the banner.
11. (call) `POST /campaigns/:id/executives` — assign Raj & Priya. Each is emailed.
12. `PATCH /campaigns/:id/approve` — **THE FREEZE.** Segmentation runs once,
    one `campaign_leads` row is written per targeted lead, call leads are
    round-robin split across executives (`queue_status = pending`), status →
    `active`.

### Phase D-call — Work the call queue (as an executive)
13. `POST /auth/login` as Raj → `GET /call/my-campaigns`.
14. `GET /call/campaigns/:id/next` — get a Call Card. (Live consent check first.)
15. `POST /call/leads/:campaignLeadId/remarks` — log the outcome. Repeat 14–15.
16. Manager: `GET /call/campaigns/:id/pending-conversions` →
    `PATCH /call/remarks/:remarkId/review` to confirm/reject claimed conversions.
17. Manager: `GET /call/campaigns/:id/progress` — rollup + live billing.

### Phase D-email — Dispatch (as manager or assigned executive)
13. `POST /email/campaigns/:id/dispatch` → 202 + job. → `email_dispatch_jobs`
14. `GET /email/dispatches/:jobId` — poll sent/failed/suppressed.
15. Engagement then arrives asynchronously via the tracking endpoints & webhook
    (§6). `GET /email/campaigns/:id/analytics` shows the funnel.

### Phase E — Deliverables
18. `GET /reports/campaigns/:id/pdf` and `/excel` — downloadable reports.
19. Client logs in → `GET /portal/dashboard`, `GET /portal/campaigns`, and can
    download the **redacted** report (identities only for Qualified/Converted).

---

## 4. Campaign approval — why "the freeze" matters

Before approval, a campaign's audience is just a *description* (segmentation
filters). At `approve`, the system resolves those filters **once** and writes
concrete `campaign_leads` rows. From then on the campaign works against those
frozen rows and never re-runs the filter.

Why: without freezing, editing a lead's industry, or a new import landing in the
same list, would silently change who a live campaign is targeting — the manager
approved one audience and a different one runs. Freezing makes the approved
audience exactly what executes.

**But consent is never frozen.** The frozen snapshot decides *who's in scope*;
`dnc`/`unsubscribed`/`hard_bounced` are re-checked **live** at the moment of
each call or send (§6, §7). So someone who opts out after approval is still
skipped, even though they're in the frozen list.

---

## 5. Segmentation — how an audience is narrowed

`campaigns.segmentation_filters` (JSONB) holds any of: `industry`, `jobTitle`,
`source`, `membershipStatus`. At approval the audience resolver:
1. starts from the source list's memberships,
2. drops `Converted`/`Dead` if `exclude_closed_leads` is true (the default),
3. applies `membershipStatus` if set (this is how sequence steps target "only
   people Qualified from step 1"),
4. applies the lead-level firmographic filters,
5. keeps only leads actually mapped to this client.

Targeting `Converted` leads while `exclude_closed_leads` is true is a
contradiction and is **rejected at creation** — you must explicitly set
`exclude_closed_leads: false` to run a deliberate re-engagement campaign.

---

## 6. Email engagement — the full mechanics (minute detail)

This is the part worth understanding precisely.

### 6.1 Dispatch
`POST /email/campaigns/:id/dispatch`:
1. The **atomic guard**: `UPDATE campaigns SET dispatch_status='sending' WHERE
   id=? AND dispatch_status='not_sent'`. If zero rows change, someone already
   triggered it → 422. This is why two simultaneous clicks can't double-send.
2. An `email_dispatch_jobs` row is created (status `queued`), and the send loop
   runs **detached** — the HTTP call returns 202 immediately.
3. The loop pulls the frozen `campaign_leads`, batches **50** with a **200ms**
   gap between batches.

### 6.2 Per recipient, at send time
For each lead the loop does, in order:
1. **Live consent re-check** (`checkContactable`, channel=email): is this lead
   now `dnc` OR `unsubscribed` OR `hard_bounced` for this client, or already
   `Converted`/`Dead`? If so → **suppressed** (counted, no email, no row).
2. Generate a unique 24-byte hex **tracking token**.
3. Create a `lead_engagements` row (status `sent`, token attached). `sentAt` is
   **not** stamped yet.
4. **Render** the email for this specific lead (`emailRenderer.js`):
   - substitute merge vars (`{{first_name}}`, `{{company}}`, etc.), each value
     **HTML-escaped** (lead data comes from uploaded CSVs — a company name with
     markup must not inject),
   - rewrite every `http(s)` link through `/track/click?token=…&url=…`,
   - prepend the banner `<img>` if set,
   - auto-inject an unsubscribe link if absent,
   - append the 1×1 open pixel `/track/open?token=…`.
5. Send via the email microservice. If the provider **accepts**, stamp `sentAt`
   and promote the lead to `Contacted`. If it **rejects**, count `failed` and
   record the error — the batch continues (one bad recipient never aborts a run).

Counters reconcile: **sent + failed + suppressed = processed**. That's why
`suppressed` is a first-class number — otherwise a "deliberately skipped" lead
would be indistinguishable from a delivery failure.

### 6.3 What "sent" means (and why it's not just "row exists")
A `lead_engagements` row is created *before* the provider call. `sentAt` is
stamped *only on provider acceptance*. So analytics count "sent" as
`sentAt IS NOT NULL` — a rejected send has a row but no `sentAt`, so it's
reported as *attempted* but never inflates *sent* or any rate derived from it.
(An earlier version filtered on `errorMessage IS NULL` — wrong, because the
webhook also writes bounce reasons there. Fixed to use `sentAt`.)

### 6.4 Engagement events (asynchronous, after the send)
- **Open** — the recipient's mail client loads the pixel → `GET /track/open`.
  Stamps `openedAt` (first time), increments `openCount`. An open does **not**
  promote status — too weak a signal.
- **Click** — they click a rewritten link → `GET /track/click`. Increments
  `clickCount`, promotes the lead to **Qualified**, then 302-redirects to the
  real URL (http/https only — a tampered `javascript:` URL is refused).
- **Convert** — they click the dedicated "I'm interested" CTA. Here's the
  subtlety: the CTA link is a **GET that only shows a confirmation page**; the
  actual conversion is the **POST** from that page. Why: corporate mail scanners
  (Safe Links, AV gateways) *prefetch every link* — a GET that converted would
  let a scanner mark leads Converted and **bill the client for a conversion that
  never happened**. A prefetch never issues a POST. (Same reason unsubscribe is
  GET-page + POST-action — RFC 8058.) On the real POST, the lead → **Converted**
  with **no human confirmation** — the lead's own click can't be faked by the
  agency, unlike a self-reported call outcome.
- **Unsubscribe** — GET shows a page, POST acts → sets
  `client_leads.is_unsubscribed = true`. Silences every campaign *this client*
  runs, never another client's. Does **not** mark the lead Dead (consent ≠
  sentiment).

### 6.5 The provider webhook (`POST /webhooks/sendgrid`)
Maps provider events to engagement rows: `delivered` stamps `deliveredAt`;
`bounce` sets `bounced` + `bounceType` (**hard → immediately suppress the
address for this client**, soft → record only); `spamreport` suppresses too;
`open`/`click` mirror the pixel/redirect logic. Always returns 200 (a provider
retries on non-2xx, but an unmatchable event won't fix itself on retry).

---

## 7. Call remarks — the full mechanics

### 7.1 Serving the queue
`GET /call/campaigns/:id/next` returns the oldest `pending`/`in_progress`/
`called` lead **in this executive's slice**. Before returning it, the **live
consent check** runs (channel=call → blocks on `dnc` only; an email unsubscribe
is *not* a "don't call me" signal). A lead now DNC or Converted/Dead elsewhere
is set to `skipped` and the loop moves on. The Call Card includes the lead's
**previous remarks** in this campaign, so a re-call isn't blind.

### 7.2 Logging an outcome
`POST /call/leads/:campaignLeadId/remarks`. What each outcome does:

| Outcome | queue_status → | membership status → | Notes |
|---|---|---|---|
| Not Answered / Busy / Left Voicemail / Answered | `called` | `Contacted` (if not already further) | Re-servable; try again later |
| Wrong Number | `completed` | unchanged | Dead-ish, but not a sentiment signal |
| Not Interested | `completed` | **`Dead`** (automatic) | Explicit negative |
| Callback Requested | `in_progress` | unchanged | **Requires `followUpDate`**; keeps campaign open |
| Converted | `completed` | **unchanged** (pending review) | Does NOT convert until a manager confirms |

Key asymmetry: most outcomes resolve the lead's turn in one attempt;
`Callback Requested` is the explicit "come back to this person" mechanism. This
is what lets a campaign actually reach completion instead of stranding leads.

An executive may also pass `leadStatusUpdate` (Contacted/Qualified) to manually
promote based on their judgment of the conversation.

### 7.3 The conversion confirmation gate (the billing trust mechanism)
When an executive logs `Converted`, the lead's status does **not** change and
nothing is billed. The claim sits in
`GET /call/campaigns/:id/pending-conversions`. A manager then
`PATCH /call/remarks/:remarkId/review`:
- **confirm** → lead becomes `Converted`, counts toward `cost_per_lead` billing.
- **reject** → reason recorded, lead untouched, still workable.

Two DB-enforced rules: the reviewer can **never** be the executive who logged it
(no self-approval), and at most **one** confirmed conversion per
`campaign_lead` (an accidental re-call can't double-bill the same person in the
same campaign). A *different* campaign converting the same lead later is allowed
— legitimate re-engagement.

### 7.4 Callbacks
`Callback Requested` keeps the lead `in_progress`, so it's re-served later.
`GET /call/campaigns/:id/callbacks-due` surfaces due/overdue callbacks — but
only the **latest** remark per lead counts, so if a later call superseded the
callback, it correctly drops off. Read-only; nothing forces resolution. An
unresolved callback holds the whole campaign open until it's worked or the
manager ends the campaign early.

---

## 8. Billing — how the number is computed

### The unit of billing is the SEQUENCE, not the campaign

A client contracts for an outreach **motion** — "run a cadence against this
list" — not for individual sends. So pricing lives on `sequences`, and a
lead who converts anywhere in that motion is billed **once**, however many
steps reached them.

**How that's guaranteed:** a `sequence_conversions` ledger with a
`UNIQUE (sequence_id, lead_id)` constraint. Every conversion — call or email,
step 1 or step 5 — attempts an insert. The first succeeds; any later one for
the same lead in the same sequence is rejected by the database. Billing then
counts **rows in the ledger**, so double-billing is structurally impossible
rather than depending on someone remembering to write `DISTINCT`.

This matters for a real case: a final "thank you" step deliberately targets
already-converted leads (`excludeClosedLeads: false`). Those emails genuinely
send, and if a lead clicks the CTA again they're genuinely recorded as
engaging — but the ledger refuses the duplicate, so the invoice doesn't move.

| Scenario | Billed |
|---|---|
| Converts at step 1 of a 3-step motion | Once |
| Converts at step 2, re-converts on the step-3 thank-you | Once |
| Converts in sequence A, later converts in sequence B | Twice (separate engagements) |
| Converts in a standalone campaign (no sequence) | Once, from the campaign's own pricing |

**Standalone campaigns still bill alone.** A campaign with no `sequenceId`
keeps its own pricing columns and computes from unique converted leads within
itself. A campaign that IS a sequence step returns
`billedAtSequenceLevel: true` pointing at its sequence rather than an amount —
otherwise three steps of one motion would each appear to owe money.

### The formulas

- `cost_per_lead`: `amount = billable_conversions × rate_per_lead`
- `flat_retainer`: `cost_per_conversion = retainer_amount ÷ billable_conversions`
  (null when there are no conversions, rather than dividing by zero)

"Billable" still means **confirmed**: a call conversion needs manager review
before it reaches the ledger; an email conversion is auto-confirmed by the
lead's own CTA click, which can't be faked by the agency.


---

## 9. The client's view — redaction

A client sees **full aggregate counts** for the whole audience (proof of effort)
but **individual identities only for Qualified/Converted leads**. Someone at
New/Contacted contributes to the counts but their name/email/phone are withheld.
Internal call notes are never exposed. Reasoning: the agency's sourced list is
its competitive asset; the client is buying qualified attention, not raw data.
The portal and the report component share the same `CLIENT_VISIBLE_STATUSES`
constant, so the dashboard's "12 qualified" always matches which 12 the report
reveals.

---

## 10. Why deactivation is "immediate"

Deactivating a user (`PATCH /users/:id/deactivate`) blocks future login **and**
bumps `token_version`. Since the access token carries the version it was issued
with, and the auth middleware compares it against the current one, an
already-issued token is rejected on its very next request — not "eventually when
it expires 15 minutes later." Same mechanism revokes sessions on password reset
and logout.

---

## Running the guided walkthrough

1. Start Postgres, run migrations (`npm run migrate`), start all services
   (`npm run dev`).
2. Open **`http://localhost:4000/api-docs`**.
3. `POST /auth/register`, then `POST /auth/login`, copy the `accessToken`, click
   **Authorize**, paste it.
4. Walk §3 top to bottom. Each endpoint's Swagger description names the tables it
   touches, so you can watch the data move.
