# LeadPulse — Complete Testing Guide

A start-to-finish walkthrough you can run yourself against a local instance,
using Swagger at **http://localhost:4000/api-docs**. Every step gives you
values you can paste directly.

By the end you will have exercised: all three roles, a call campaign, an email
campaign, a multi-step sequence with sequence-level billing, engagement
tracking, reports, and the client portal.

---

## 0. Setup

```bash
npm install
createdb leadpulse_dev          # or via pgAdmin
cp .env.example .env            # adjust DB_USER / DB_PASSWORD if needed
npm run migrate
npm run dev                     # starts all three services
```

You should see three services come up: api (4000), upload (4001), email (4002).

Open **http://localhost:4000/api-docs**.

### Keeping track of IDs

You'll collect several IDs as you go. Keep a scratch note:

```
accessToken (manager)  =
clientId               =
executiveId            =
leadListId             =
sequenceId             =
campaignId (step 1)    =
campaignId (step 2)    =
executive accessToken  =
client accessToken     =
```

---

## Phase A — Authentication & onboarding

### A1. Register a Campaign Manager
`POST /api/v1/auth/register`
```json
{
  "firstName": "Asha",
  "lastName": "Rao",
  "email": "asha@acme-agency.com",
  "password": "Str0ng!Pass",
  "confirmPassword": "Str0ng!Pass"
}
```
**Expect 201.** Check the `[email]` terminal — a welcome email is logged.
→ writes `users`

**Also try:** the same request again → **409** (registration is the one flow
that confirms an email exists, because you need to be told to log in instead).
And a `"password": "weak"` → **400** with a `details` array naming each rule
that failed.

### A2. Log in
`POST /api/v1/auth/login`
```json
{ "email": "asha@acme-agency.com", "password": "Str0ng!Pass" }
```
Copy `data.accessToken`. In Swagger click **Authorize** (top right), paste it,
click Authorize. Everything below now carries it.
→ reads/writes `users`

### A3. Create a Client
`POST /api/v1/clients`
```json
{ "name": "Acme Corp", "contactPerson": "Mark", "contactEmail": "mark@acme.com" }
```
Save `data.id` as **clientId**. → writes `clients`

### A4. Create an Executive
`POST /api/v1/users/executives`
```json
{
  "firstName": "Raj",
  "lastName": "Kumar",
  "email": "raj@acme-agency.com",
  "temporaryPassword": "Str0ng!Raj1"
}
```
Save `data.id` as **executiveId**. → writes `users`

The temp password is emailed (check the `[email]` terminal). If you **omit**
`temporaryPassword`, one is generated for you and appears only in that email —
which is the realistic flow. Setting it explicitly here just makes testing
easier.

### A5. Create a Client portal user
`POST /api/v1/users/client-users`
```json
{
  "clientId": "<clientId>",
  "firstName": "Mark",
  "lastName": "Client",
  "email": "mark@acme.com",
  "temporaryPassword": "Cl!entPass9"
}
```
→ writes `users`

### A6. See your team
`GET /api/v1/users/executives` — shows each executive with assigned campaigns,
calls logged, and **open leads** (the last matters before deactivating anyone).

---

## Phase B — Get leads in

### B1. Prepare a CSV

Create `leads.csv` on your machine. **Headers must be exactly these:**

```csv
first_name,last_name,email,phone,company,job_title,industry,source
Ann,Anderson,ann@example.com,9000000001,AlphaCo,VP Engineering,Manufacturing,LinkedIn
Ben,Brown,ben@example.com,9000000002,BetaCo,VP Sales,Manufacturing,LinkedIn
Cat,Clark,cat@example.com,9000000003,GammaCo,Director,Retail,Referral
Dan,Davis,dan@example.com,9000000004,DeltaCo,Manager,Retail,Web
,NoFirstName,bad-email-no-at-sign,9000000005,X,Y,Z,W
```

That last row is deliberately broken — it tests the error path.

> **Tip:** if you want to receive real emails later, replace one address with a
> Gmail address you control (see Phase E2).

### B2. Start the import
`POST /api/v1/leads/import` — Swagger shows a **file picker** here.
- `clientId` = your clientId
- `leadListName` = `Q3 Prospects`
- `file` = choose `leads.csv`

**Expect 202** and a job `id` — the response comes back instantly because
parsing happens in the background. Save the job id.
→ writes `import_jobs`

### B3. Poll the job
`GET /api/v1/leads/imports/{jobId}/status`

Repeat until `status` is terminal. You should see:
- `status`: `completed_with_errors`
- `newToAgency`: 4
- `failedRows`: 1 (the broken row)
- `leadListId` — **save this as leadListId**

**Why `completed_with_errors` and not `failed`:** one bad row shouldn't discard
99 good ones. The good rows are committed; the bad one is reported.

### B4. Download the error file
`GET /api/v1/leads/imports/{jobId}/errors` — a CSV of the rejected rows with
reasons, so you can fix and re-upload.

### B5. Browse the leads
`GET /api/v1/leads?clientId=<clientId>` — 4 leads, all `New`.

**Save these lead IDs** — you'll need Ann's and Ben's later.

**Try the filters:** `?clientId=<id>&industry=Manufacturing` → 2 leads.

### B6. Re-import the same file (the upsert test)
Run B2 again with the **same** `leadListName`. Watch the summary:
`alreadyMappedToThisClient: 4`, `newToAgency: 0`. Nothing duplicated — the
`(client_id, email)` uniqueness forces an upsert.

---

## Phase C — A CALL campaign (single, standalone)

### C1. Create the campaign
`POST /api/v1/campaigns`
```json
{
  "clientId": "<clientId>",
  "leadListId": "<leadListId>",
  "name": "Q3 Manufacturing Calls",
  "type": "call",
  "segmentationFilters": { "industry": "Manufacturing" },
  "pricingModel": "cost_per_lead",
  "ratePerLead": 8
}
```
Save `data.id` as **callCampaignId**. Status is `draft` — the audience is
**not** frozen yet. → writes `campaigns`

### C2. Try approving it now (this should fail)
`PATCH /api/v1/campaigns/{id}/approve` → **422**: a call campaign needs at least
one executive. (An email campaign doesn't — a manager can run one solo.)

### C3. Assign the executive
`POST /api/v1/campaigns/{callCampaignId}/executives`
```json
{ "executiveUserIds": ["<executiveId>"] }
```
Raj is emailed about the assignment. → writes `campaign_executives`

### C4. Approve — **THE FREEZE**
`PATCH /api/v1/campaigns/{callCampaignId}/approve`

`audienceCount` should be **2** (only the Manufacturing leads matched).
Status → `active`.
→ writes `campaign_leads` (one row per lead, `queue_status: pending`), `campaigns`

This is the most important transition in the system: segmentation runs **once**
and the result is frozen. Editing a lead's industry afterwards will not change
who this campaign targets.

### C5. Log in as the Executive
`POST /api/v1/auth/login` with `raj@acme-agency.com` / `Str0ng!Raj1`.

In Swagger, click **Authorize** and swap in Raj's token.

### C6. See Raj's campaigns
`GET /api/v1/call/my-campaigns` — one campaign, `myPendingLeads: 2`.

### C7. Get a Call Card
`GET /api/v1/call/campaigns/{callCampaignId}/next`

Returns one lead with phone, company, and `previousRemarks` (empty first time).
Save `campaignLeadId`.

Before returning it, the system re-checks **live** whether this lead is still
contactable — see Phase G.

### C8. Log outcomes — try each one

`POST /api/v1/call/leads/{campaignLeadId}/remarks`

**Unanswered** (lead stays workable):
```json
{ "callOutcome": "Not Answered", "callDurationMinutes": 0 }
```
→ status becomes `Contacted`, `queue_status` becomes `called`. The lead is
**re-servable later**, but goes to the BACK of the queue — your **next** call
serves a *different* lead. The unreached one cycles back only after the rest of
your slice, so you're never stuck hammering the same person.

**Callback** (requires a date):
```json
{ "callOutcome": "Callback Requested", "followUpDate": "2026-03-01", "notes": "Call back Tuesday" }
```
→ `queue_status` becomes `in_progress`.
**Try it without `followUpDate`** → **400**. **Try a `followUpDate` on a
non-callback outcome** → also **400**.

**Not interested** (hard stop):
```json
{ "callOutcome": "Not Interested" }
```
→ status becomes **`Dead`** automatically, `queue_status` → `completed`.
Try logging another remark on this lead → **422** (already resolved).

**Converted** (the interesting one):
```json
{ "callOutcome": "Converted", "callDurationMinutes": 12, "notes": "Verbally agreed" }
```
→ Response has `awaitingConversionReview: true`. The lead's status does **NOT**
become Converted yet, and **nothing is billed**.

### C9. Switch back to the Manager, review the conversion
Re-authorize with the manager token.

`GET /api/v1/call/campaigns/{callCampaignId}/pending-conversions` — the claim
appears here. Save the `remarkId`.

`PATCH /api/v1/call/remarks/{remarkId}/review`
```json
{ "confirmed": true }
```
→ **Now** the lead becomes `Converted` and billing accrues.

**Try rejecting instead** (on a different conversion):
```json
{ "confirmed": false, "rejectionReason": "Customer has not actually signed" }
```
Rejecting **without** a reason → **400**. Reviewing an already-reviewed
conversion → **422**.

**The rule being enforced:** the reviewer can never be the executive who
reported it. That's a database constraint, not just app logic.

### C10. Manager rollup
`GET /api/v1/call/campaigns/{callCampaignId}/progress`

Queue counts, per-executive stats (calls logged, avg duration, **conversions
claimed vs confirmed** — deliberately both), and billing computed from
**confirmed only**.

### C11. Callbacks due
`GET /api/v1/call/campaigns/{callCampaignId}/callbacks-due`

Shows the callback from C8, flagged `overdue` if the date has passed. Now log a
*different* outcome on that same lead and check again — the callback correctly
**drops off**, because only the latest remark per lead counts.

---

## Phase D — A SEQUENCE (multi-step, the real cadence)

This is where sequence-level billing matters.

### D1. Create the sequence
`POST /api/v1/sequences`
```json
{
  "clientId": "<clientId>",
  "leadListId": "<leadListId>",
  "name": "Q3 Outbound Motion",
  "description": "Email, then call the engaged, then thank the converted",
  "pricingModel": "cost_per_lead",
  "ratePerLead": 10
}
```
Save as **sequenceId**. **Pricing lives here, not on the steps** — the client
contracted for the motion, not for individual sends.
→ writes `sequences`

### D2. Step 1 — a broad email
`POST /api/v1/campaigns`
```json
{
  "clientId": "<clientId>",
  "leadListId": "<leadListId>",
  "name": "Step 1 - Intro Email",
  "type": "email",
  "sequenceId": "<sequenceId>",
  "sequenceStepOrder": 1,
  "subjectLine": "Quick question, {{first_name}}",
  "senderName": "Acme Agency",
  "emailBodyHtml": "<p>Hi {{first_name}} at {{company}},</p><p>We help teams like yours. <a href=\"https://example.com/offer\">See how</a>.</p><p><a href=\"http://localhost:4000/api/v1/track/convert?token=PLACEHOLDER\">I'm interested</a></p>"
}
```

**Note:** the `token=PLACEHOLDER` is fine — the renderer rewrites links
per-recipient with their real token at send time.

Approve it: `PATCH /api/v1/campaigns/{id}/approve`

### D3. Dispatch
`POST /api/v1/email/campaigns/{step1Id}/dispatch` → **202 + job id**

`GET /api/v1/email/dispatches/{jobId}` — poll until terminal. You'll see
`sent`, `failed`, `suppressed`. They always reconcile:
**sent + failed + suppressed = processed**.

**Try dispatching again immediately** → **422** ("already being dispatched" or
"already dispatched"). That's the atomic double-send guard.

### D4. Simulate engagement (see Phase E for the real-email version)

You need a `trackingToken`. Get one from the database:
```sql
SELECT le.tracking_token, l.email
FROM lead_engagements le
JOIN campaign_leads cl ON cl.id = le.campaign_lead_id
JOIN leads l ON l.id = cl.lead_id
WHERE cl.campaign_id = '<step1Id>';
```

**Open** — `GET /api/v1/track/open?token=<token>`
→ returns a 1×1 GIF. `openCount` increments. Status does **not** change (an
open is too weak a signal).

**Click** — `GET /api/v1/track/click?token=<token>&url=https://example.com/offer`
→ 302 redirect. Lead is promoted to **Qualified**.

**Convert** — `POST /api/v1/track/convert` with `{ "token": "<token>" }`
→ Lead promoted to **Converted**, and a billing ledger row is written.

> Note the GET version of `/track/convert` only shows a confirmation page and
> writes nothing — that's deliberate, so mail scanners prefetching links can't
> create fake conversions. See Phase G.

### D5. Check sequence billing
`GET /api/v1/sequences/{sequenceId}`

```
totals.uniqueLeadsReached : 4        ← unique PEOPLE, not row count
totals.convertedLeads     : 1
billing.amountAccrued     : 10       ← 1 × $10
conversionsByStep         : step 1 → 1
```

### D6. Step 2 — call only the engaged
`POST /api/v1/campaigns`
```json
{
  "clientId": "<clientId>",
  "leadListId": "<leadListId>",
  "name": "Step 2 - Call the Qualified",
  "type": "call",
  "sequenceId": "<sequenceId>",
  "sequenceStepOrder": 2,
  "segmentationFilters": { "membershipStatus": "Qualified" }
}
```
Assign Raj, approve. **The audience is only the leads who clicked in step 1** —
this is the cadence logic: each step targets the outcome of the previous one.

Work it as in Phase C, convert someone, confirm it. Check
`GET /api/v1/sequences/{sequenceId}` → `amountAccrued` is now **20**.

### D7. Step 3 — the thank-you (the key test)
```json
{
  "clientId": "<clientId>",
  "leadListId": "<leadListId>",
  "name": "Step 3 - Thank You",
  "type": "email",
  "sequenceId": "<sequenceId>",
  "sequenceStepOrder": 3,
  "segmentationFilters": { "membershipStatus": "Converted" },
  "excludeClosedLeads": false,
  "subjectLine": "Thanks, {{first_name}}!",
  "senderName": "Acme Agency",
  "emailBodyHtml": "<p>Thanks {{first_name}} — we'll be in touch.</p><p><a href=\"http://localhost:4000/api/v1/track/convert?token=X\">Confirm interest</a></p>"
}
```

`excludeClosedLeads: false` is what lets a step deliberately target already
converted leads. Approve and dispatch — the emails **do** send.

Now **convert the same lead again** via `POST /api/v1/track/convert`.

Check `GET /api/v1/sequences/{sequenceId}`:
```
billing.amountAccrued : 20     ← STILL 20, not 30
```

**This is the core business rule:** one lead is billed once per sequence,
however many steps reach them. Enforced by a unique constraint on
`sequence_conversions (sequence_id, lead_id)` — it cannot be violated.

### D8. A step doesn't bill on its own
`GET /api/v1/email/campaigns/{step1Id}/analytics` →
`billing.billedAtSequenceLevel: true` with a pointer to the sequence, rather
than its own amount. Otherwise a 3-step motion would appear to owe three times.

---

## Phase E — Real email delivery & tracking

### E1. Without a real provider (the default)

The email service **stubs** delivery: it logs what it would have sent instead of
sending. Everything else works — engagement is simulated by calling the tracking
endpoints directly, as in D4. **This is enough to demonstrate the whole system.**

### E2. With real emails (optional, more impressive)

Two things are needed, and they're independent:

**(a) Real sending — SendGrid**
1. Create a free SendGrid account, verify a single sender address.
2. Put in `.env`:
   ```
   SENDGRID_API_KEY=SG.xxxxx
   SENDGRID_FROM_EMAIL=your-verified@address.com
   ```
3. Restart. The email service now sends for real. Put your Gmail address in the
   CSV and you'll receive the campaign email.

**(b) Real tracking — this is where a tunnel is needed**

Here's the thing to understand. The email contains:
```html
<img src="http://localhost:4000/api/v1/track/open?token=abc123">
```
When Gmail opens that email **on Google's servers**, `localhost:4000` means
*Google's* localhost — not your laptop. The request never reaches you, so
`lead_engagements` never updates.

**Fix: expose your local API with a tunnel.**

```bash
# ngrok (sign up free, then)
ngrok http 4000
# → gives you https://abc123.ngrok-free.app
```
or
```bash
cloudflared tunnel --url http://localhost:4000
```

Then in `.env`:
```
TRACKING_BASE_URL=https://abc123.ngrok-free.app/api/v1
APP_URL=https://abc123.ngrok-free.app
```
Restart and re-dispatch. Now the pixel, click links and unsubscribe links all
point at a publicly reachable URL, and opening the email in Gmail **really does**
populate `lead_engagements`.

**(c) Real bounce/delivery events — the SendGrid webhook**

In SendGrid → Settings → Mail Settings → Event Webhook, set the URL to:
```
https://abc123.ngrok-free.app/api/v1/webhooks/sendgrid
```
and enable Delivered, Bounced, Spam Reports. Now `deliveredAt` and hard-bounce
suppression populate from real provider events.

**Without a tunnel you can still simulate every event** by POSTing to
`/api/v1/webhooks/sendgrid` yourself:
```json
[{ "event": "bounce", "type": "bounce", "token": "<trackingToken>", "reason": "550 no such user" }]
```

### E3. Verify tracking worked
```sql
SELECT tracking_token, status, sent_at, opened_at, open_count,
       clicked_at, click_count, converted_at, unsubscribed_at, bounce_type
FROM lead_engagements ORDER BY created_at DESC LIMIT 10;
```

---

## Phase F — Reports & the Client Portal

### F1. Campaign-level reports (manager)
- `GET /api/v1/reports/campaigns/{campaignId}/pdf`
- `GET /api/v1/reports/campaigns/{campaignId}/excel`

Swagger will show a **Download file** link.

### F2. Sequence-level reports — the client-facing deliverable
- `GET /api/v1/reports/sequences/{sequenceId}/pdf`
- `GET /api/v1/reports/sequences/{sequenceId}/excel`

One document for the whole motion: deduplicated totals, one amount owed, and the
step-by-step breakdown. Contains **no lead identities** by design.

### F3. Log in as the Client
`POST /api/v1/auth/login` with `mark@acme.com` / `Cl!entPass9`. Re-authorize
with that token.

| Endpoint | What they see |
|---|---|
| `GET /api/v1/portal/dashboard` | Aggregate counts. `leadsTargeted` counts **unique people** |
| `GET /api/v1/portal/sequences` | Each motion with totals, steps, and one billing figure |
| `GET /api/v1/portal/sequences/{id}` | One motion in detail |
| `GET /api/v1/portal/campaigns` | Campaign history, flagged as sequence step or standalone |
| `GET /api/v1/reports/sequences/{id}/pdf` | Their own report, downloadable |

### F4. Verify the redaction
`GET /api/v1/reports/campaigns/{callCampaignId}/excel` **as the client**, then
open the file:
- Qualified/Converted leads → full contact details visible
- Everyone else → `(withheld)`
- Call notes → `(internal)` — never exposed

Download the same file **as the manager** and compare: all leads, all notes.

### F5. Verify isolation
While still authorized as the client, try
`GET /api/v1/campaigns` → **403** (manager-only route).
Try another client's sequence → **404** (never 403 — we don't confirm it exists).

---

## Phase G — The safeguards worth demonstrating

These are the details that show the system is designed, not just assembled.

### G1. Live consent re-check
1. As manager: `PATCH /api/v1/leads/{leadId}/dnc` with
   `{ "clientId": "<clientId>", "dnc": true }` — pick a lead who is still
   `pending` in an active call campaign.
2. As the executive, call `GET /api/v1/call/campaigns/{id}/next` repeatedly.
   **That lead is never served.** Check the DB: their `queue_status` is now
   `skipped`.

The audience was frozen at approval, but **consent is re-checked live at the
moment of contact** — so an opt-out after approval is still honoured.

### G2. Unsubscribe is per-client, not global
Unsubscribe a lead (`POST /api/v1/track/unsubscribe`). Create a **second**
client, import the same email address, run a campaign — **it still sends**. One
client's unsubscribe never silences another client's outreach to the same person.

### G3. Hard bounce suppresses immediately
POST the bounce webhook from E2(c). Then run a *new* email campaign including
that lead → they're counted as `suppressed`, no email sent. No threshold, no
waiting.

### G4. The forward-only status guard
Manually set a lead to `Qualified`
(`PATCH /api/v1/leads/{id}/status`). Then log a `Not Answered` call on them.
Their status stays **Qualified** — an automatic event can never demote a lead.
But a manual override can move it any direction (that's how a manager fixes a
mistake).

### G5. Scanner-prefetch protection
`GET /api/v1/track/convert?token=<token>` → returns an HTML form, **writes
nothing**. Only `POST` converts. This stops corporate mail scanners (which
prefetch every link) from creating conversions the client would be billed for.

---

## Quick reference — what each enum means

**`MEMBERSHIP_STATUS`** (per lead, per list — the funnel)
| Value | Set by |
|---|---|
| `New` | import |
| `Contacted` | email sent, or any call attempt |
| `Qualified` | email **click**, or executive judgement |
| `Converted` | email CTA click, or **confirmed** call conversion |
| `Dead` | call outcome "Not Interested", or manager override |

**`QUEUE_STATUS`** (per lead, per call campaign)
| Value | Meaning |
|---|---|
| `pending` | never attempted |
| `in_progress` | open callback |
| `called` | attempted, unresolved — **still re-servable** |
| `completed` | resolved |
| `skipped` | pulled by consent check, or swept when ending early |

**`CAMPAIGN_STATUS`**: `draft` → `active` → (`paused`) → `completed`
**`DISPATCH_STATUS`**: `not_sent` → `sending` → `sent` (the double-send lock)
**`BOUNCE_TYPE`**: `hard` suppresses permanently; `soft` records only

---

## If something doesn't work

| Symptom | Cause |
|---|---|
| All services crash on `No Sequelize instance passed` | A model file is misnamed — every one must end `.model.js` |
| `ECONNREFUSED 5432` | Postgres isn't running |
| Import job stuck at `processing` | The upload service isn't running — check the `[upload]` terminal |
| Emails "sent" but nothing in `lead_engagements` | Expected without a tunnel — see Phase E2 |
| 401 on every call | Token expired (15 min). Log in again and re-Authorize |
| 403 on a route that should work | You're authorized as the wrong role — re-Authorize |
