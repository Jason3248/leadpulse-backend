# LeadPulse

A B2B outbound lead-generation campaign management platform, built as a capstone project.
Monorepo, npm workspaces. Core business logic lives in one Express API; file parsing and
email dispatch are split out into two small standalone microservices.

## Architecture

```
leadpulse-workspace/
├── leadpulse-api/                 Main REST API (Express) — all business logic lives here
│   ├── app/
│   │   ├── components/            controller + service + validation, one folder per feature
│   │   │   ├── auth/
│   │   │   ├── client/
│   │   │   ├── leadList/
│   │   │   └── lead/
│   │   ├── configs/
│   │   │   ├── route.config.json  central route table
│   │   │   ├── route-config.js    dynamic route loader
│   │   │   └── logger.js          Winston
│   │   ├── middleware/            auth, role guards, validation, upload, error handling
│   │   ├── lib/                   AppError + domain error taxonomy
│   │   ├── utils/                 password/token helpers, microservice HTTP clients
│   │   ├── app.js
│   │   └── server.js
│   └── package.json
│
├── leadpulse-data-model/          Sequelize models, migrations, seeders
│   ├── lib/constants.js           every enum used across the schema, one source of truth
│   ├── config/config.js
│   ├── db/
│   │   ├── models/                 12 models + associations
│   │   ├── migrations/             14 migrations, dependency-ordered
│   │   └── seeders/
│   ├── .sequelizerc
│   ├── index.js                    exports { ...models, constants }
│   └── package.json
│
├── leadpulse-upload-service/      Microservice #1 — the Lead Import Service.
│   ├── app/server.js               Async trigger endpoint (202) + health check
│   └── app/importProcessor.js      Parses CSV/XLSX, validates, batched upsert,
│                                    writes the error file, updates job progress
│
├── leadpulse-email-service/       Microservice #2 — accepts a send request, dispatches it.
│   └── app/server.js               Currently stubs delivery with a log (no SendGrid yet).
│                                    Swapping in real delivery later touches only this file.
│
├── dev-all.js                      Spawns all three services together for local dev
├── test-runner.js                  Self-contained integration test (spawns all 3, hits real DB)
├── .env.example
├── .env
└── package.json                    npm workspaces root
```

### Why these two are microservices and nothing else is

The architecture is a **modular monolith plus two focused background-processing
services**, per the updated SRS. Lead-file processing and email dispatch are both
long-running workloads that must not block the request-response lifecycle — everything
else (auth, campaigns, RBAC, analytics) stays in the Core Application where it belongs.

Splitting exactly these two means: the Core Application never holds a request open while
a 10 MB spreadsheet is parsed, a failure in either service is contained and reported
through job status rather than crashing a user request, and each can be scaled or
redeployed independently on AWS.

**Deliberately NOT built:** Amazon SQS. The SRS itself lists it as an optional stretch
goal and states that REST is sufficient for completion, so service triggering is a
direct authenticated REST call.

### Asynchronous lead import

```
Browser ──upload──> Core API ──stores file──> storage (local disk or S3)
                        │ creates import_jobs row, returns 202 + job id
                        └──REST trigger──> Lead Import Service
                                              │ reads file, parses CSV/XLSX
                                              │ validates + upserts in batches of 100
                                              │ updates job progress after each batch
                                              │ writes errors.csv for rejected rows
                                              └ deletes the source file when terminal
Browser ──polls──> GET /leads/imports/:jobId/status
```

Job states: `uploaded → queued → processing → completed | completed_with_errors | failed`.
Progress (`totalRows`, `processedRows`, `successfulRows`, `failedRows`, `progressPercentage`)
is written after every committed batch, so the UI sees it advance rather than jumping from
0 to 100. Rejected rows never block the rest of the import — they're collected into a
downloadable CSV carrying the original row plus the reason it failed.

### Request flow

```
Browser → leadpulse-api (auth, ownership, business logic)
              │
              ├──HTTP──> leadpulse-upload-service   (CSV file → parsed JSON rows)
              └──HTTP──> leadpulse-email-service     (send request → dispatched)
              │
              └──> Sequelize → PostgreSQL
```

The browser only ever talks to `leadpulse-api` — the two microservices are internal-only,
never exposed to the frontend, and every one of their endpoints (except `/health`) requires
a shared service token via the `x-service-token` header.

## Exploring the backend (for review / demo)

Three ways to see the whole system, from quickest to most hands-on:

1. **Guided walkthrough script** — `node demo-walkthrough.js` spins up all
   services against a fresh DB and runs the entire flow (register → onboard →
   import → call campaign → email campaign → reports → client portal) with
   narrated output showing which tables each step touches. This is the fastest
   way to confirm the backend runs end to end.

2. **Interactive API docs (Swagger)** — start the app and open
   **http://localhost:4000/api-docs**. Every one of the 69 endpoints is
   documented with its purpose, the database tables it reads/writes, and its
   access role. `POST /auth/login`, copy the `accessToken`, click **Authorize**,
   and you can drive the full flow by hand — exactly as a frontend would.

3. **Hands-on testing guide** — `TESTING_GUIDE.md` is a start-to-finish script
   you can follow in Swagger, with copy-paste example values for every step. It
   covers all three roles, both campaign types, a multi-step sequence, and the
   safeguards worth demonstrating. It also explains how to get **real email
   tracking** working (you need a tunnel — see its Phase E).

4. **Campaign flows in full** — `CAMPAIGN_FLOWS.md` is the deep reference: every
   state transition, every call outcome, every engagement event, which tables
   each writes, sequence billing, what the client sees and why, and a complete
   worked example with numbers.

5. **Concept breakdown** — `BACKEND_WALKTHROUGH.md` explains every enum value
   (what it means, when it changes), the two-tier lead model, and the minute
   mechanics of email engagement tracking and call remarks.

`sample-leads.csv` at the repo root is ready to upload — 4 valid rows plus one
deliberately broken row so you can see the error path.

## Setup

**Prerequisites:** Node.js 18+, PostgreSQL 14+ running locally.

```bash
# 1. Install everything (root + all four workspaces)
npm install

# 2. Create the database
createdb leadpulse_dev

# 3. Copy env and adjust if your Postgres credentials differ
cp .env.example .env

# 4. Run migrations
npm run migrate

# 5. Start all three services together
npm run dev
```

The main API listens on `http://localhost:4000`, the upload service on `4001`, the email
service on `4002` (all configurable via `.env`). `npm run dev` runs all three at once with
prefixed, color-coded logs; Ctrl+C stops all three together. Run `npm run dev:api` /
`dev:upload` / `dev:email` individually if you want them in separate terminals instead.

## Running the test suite

```bash
node test-runner.js
```

This spawns all three services itself, runs the full flow against a real Postgres database,
and tears everything down afterward. Make sure nothing else is already running on ports
4000–4002 first, and that migrations have been run.

## What's built so far

- **Data layer, complete**: 12 tables, every association, every DB-level safeguard
  (global `leads` unique on email; `client_leads` per-relationship mapping unique on
  `(client_id, lead_id)`; partial unique index preventing duplicate active executive
  assignment; the pricing/self-confirmation/confirmation-consistency CHECK constraints;
  and the new partial unique index preventing a second confirmed conversion for the same
  lead within the same campaign).
- **Auth, complete end to end**: registration, login with lockout, silent refresh with
  rotation, logout, forgot/reset password (now dispatched via the email microservice) with
  no enumeration leak, `tokenVersion`-based revocation.
- **Client / LeadList / Lead, complete end to end, now on the shared-database model**:
  - `leads` is a **global, agency-wide identity table** — one row per real person,
    regardless of how many Clients later target them.
  - `client_leads` carries each Client's own relationship to that person: `dnc`,
    `isUnsubscribed`, `isHardBounced`. These are per-Client by design — an unsubscribe
    from one Client's outreach never silently blocks a different Client's campaigns for
    the same real person, but it DOES apply across every product/list that Client runs.
  - **Import summary is now three-tiered**, not just imported/updated: `newToAgency`
    (genuinely new person), `matchedFromAgencyDatabase` (already known to the agency,
    first time mapped to THIS client), `alreadyMappedToThisClient` (pure re-upload).
    This is deliberately privacy-safe — a Manager learns "we already know this person"
    without ever learning which other Client they came from.
  - **Ethical firewall**: a lead's detail view is always scoped to one Client via a
    required `clientId` — it can never show which other Clients (potentially
    competitors) are also targeting the same real person.
  - `consentSource` was dropped entirely — it never gated any actual behavior (unlike
    `dnc`/`isUnsubscribed`/`isHardBounced`, which are checked live before contact), so it
    was compliance-flavored metadata, not a functional field.
- **Live-status-recheck foundation**: `leadStatus.service.js` now exports
  `isLeadCurrentlyContactable()` — the exact check a future Call Queue / Email dispatch
  loop must call immediately before contacting each lead, so a lead who gets Converted or
  Dead via a *different*, concurrently-running campaign is never contacted again from a
  stale frozen snapshot. Not wired into an engine yet since neither exists — built now as
  the choke-point those engines will use, rather than inventing it twice later.
- **Confirmed-conversion guard**: at most one confirmed conversion per `(campaign_id,
  lead_id)` — prevents an accidental re-call from double-billing a client for the same
  person in the same campaign, while still allowing a genuinely new campaign to bill a
  legitimate re-engagement of the same lead.

## Bugs found and fixed during testing (not before)

- **Sequelize timestamp attribute mapping** (carried over from the previous pass):
  `createdAt: 'created_at'` as a string renames the JS attribute, not just the column —
  fixed across all affected models by relying on `underscored: true`'s default behavior.
- **`budgetAlert90Sent`/`budgetAlert100Sent` column mapping**: `underscored: true` only
  inserts an underscore at a lowercase→uppercase transition, not before a digit — so
  `budgetAlert90Sent` auto-mapped to `budget_alert90_sent`, not the migration's actual
  `budget_alert_90_sent` column. Found the moment anything first tried to create a
  `Campaign` row (via this pass's new constraint tests — no Campaign feature exists yet
  to have caught it otherwise). Fixed with an explicit `field` override on both
  attributes; every other model was then scanned for the same digit-adjacent-to-letter
  pattern and confirmed clean.

## Deployment

The project is built to be deployment-ready rather than deployment-coupled: everything
that differs between a laptop and AWS is an environment variable, not a code change.

### Running the full stack in containers locally

```bash
docker compose up --build
```

This runs all three services plus Postgres exactly as they run in AWS. If this works,
the ECS deployment is the same images with RDS swapped in for the Postgres container.

### Moving to AWS

1. **Build and push images** — one per service, using the provided Dockerfiles
   (multi-stage, non-root user, production dependencies only).
2. **Amazon RDS** — create the Postgres instance, then set `DATABASE_URL` and
   `NODE_ENV=production`. Run `npm run migrate` once against it.
3. **Amazon S3** — create a private bucket, then set `STORAGE_DRIVER=s3`,
   `AWS_REGION` and `S3_BUCKET`. No code changes: the storage layer has a local-disk
   driver and an S3 driver behind one interface, chosen by that variable.
4. **Amazon ECS/Fargate** — one task definition per service. Point the API at the two
   services via `UPLOAD_SERVICE_URL` / `EMAIL_SERVICE_URL` using internal service
   discovery. Only the API needs a public load balancer; the other two stay private.
5. **Health checks** — every service exposes an unauthenticated `GET /health` for
   ECS/ALB target-group probes.
6. **Secrets** — `JWT_ACCESS_SECRET`, `SERVICE_AUTH_SECRET` and the database URL belong
   in AWS Secrets Manager or SSM Parameter Store, injected as task environment. S3 access
   should come from the ECS task role rather than static keys.
7. **CloudWatch** — container stdout is already structured JSON via Winston, so the
   awslogs driver captures it with no code change.

### S3 lifecycle policy

Import source files are deleted by the application as soon as a job reaches a terminal
state. Error files are intentionally left for download; add an S3 lifecycle rule expiring
`imports/` objects after 24 hours so nothing lingers if a job dies mid-processing.

## Known, deliberate gaps (documented, not silent)

- **Email delivery is stubbed** — `leadpulse-email-service` logs what it would send.
  Swapping in SendGrid touches only that one service.
- **Amazon SQS is not implemented** — the SRS lists it as an optional stretch goal and
  states REST is sufficient; service triggering is a direct authenticated REST call.
- **reCAPTCHA verification** isn't implemented.
- **CSV/XLSX column mapping is fixed**, not a wizard — exact headers expected
  (`first_name, last_name, email, phone, company, job_title, industry, source`).
- **Executive deactivation does not auto-reassign** unresolved call-queue leads.
- **Single refresh token per user** — one active session at a time by design.
- **Multi-executive campaigns are a deliberate deviation from SRS 4.2.2**, which
  specifies one executive per campaign. A call campaign against thousands of leads
  bottlenecked on one person doesn't reflect how real call operations run, so campaigns
  support multiple assigned executives with automatic round-robin lead distribution and
  manual reassignment. This is a considered improvement, not an oversight.
- **Live contactability re-check is built but not yet wired in** — no Call/Email engine
  exists yet to call `isLeadCurrentlyContactable()` from.

## Call engine (built this pass)

The execution layer for call campaigns — the first component where leads are
actually *worked* rather than just organised.

- **Queue serving** (`GET /call/campaigns/:id/next`) — each executive is served only
  their own slice of the frozen audience, oldest first, with the lead's prior remarks
  attached so a re-call isn't made blind.
- **The live contactability check runs here.** Before any Call Card is shown, the lead
  is re-checked against *current* state, not the frozen snapshot: already Converted or
  Dead via a concurrently-running campaign, or newly marked DNC. Anyone failing is
  retired as `skipped` on the spot and the queue moves on. Consent is channel-specific —
  calls block on `dnc` only, never on an email unsubscribe.
- **Remark logging** with outcome-driven status transitions:
  - `Not Interested` → membership status becomes `Dead` automatically (an explicit human
    "no" is a definite negative signal)
  - `Converted` → deliberately does **not** promote the lead; it waits for review
  - `Callback Requested` → keeps the lead `in_progress` so the campaign stays open, and
    requires a follow-up date
  - any other outcome → at least `Contacted`, since an attempt was genuinely made
- **Queue semantics**: one attempt per lead by default. An attempted-but-unresolved lead
  moves to `called` and leaves the active queue; `Callback Requested` is the explicit
  mechanism for scheduling a retry, which returns the lead to the queue.
- **Conversion review gate** (`PATCH /call/remarks/:id/review`) — the billing trust
  mechanism. A claimed conversion sits in the manager's review inbox
  (`/pending-conversions`) and counts for nothing until confirmed. Confirming promotes
  the lead to `Converted` and makes it billable; rejecting records who rejected it and
  why, leaving the lead workable. Enforced at the DB level: the reviewer can never be the
  reporting executive, and only one confirmed conversion can exist per frozen audience row.
- **Callbacks due** — read-only, and only the *most recent* remark per lead counts, so a
  callback superseded by a later call correctly drops off instead of lingering.
- **`called` is a re-servable state, not a dead end.** Not Answered / Busy / Left
  Voicemail / Answered-with-no-outcome all leave the lead workable — re-served the same
  way pending leads are, no cooldown. Found and fixed during review: the first version
  excluded `called` from the serve query, which would have stranded almost every lead
  after one unanswered attempt (the most common outcome in any real campaign) with no
  path back into the queue — making "complete by exhaustion" practically unreachable.
  The end-early sweep was updated to match, so a straggler sitting in `called` is
  correctly treated as still-open when a campaign ends before finishing.
- **Manager progress rollup** — queue counts, per-executive stats (calls logged, average
  duration, conversions claimed vs. confirmed), and live billing. Only **confirmed**
  conversions ever accrue against the client.

Executives authenticate and work entirely through the API — this is the first component
with genuinely executive-facing routes rather than manager-only ones.

## Email engine (built this pass)

Async dispatch, full engagement tracking, and provider integration.

- **Async dispatch** (`POST /email/campaigns/:id/dispatch`) — returns **202 immediately**
  with a job reference; the send runs detached and the caller polls
  `GET /email/dispatches/:jobId`. A new `email_dispatch_jobs` table mirrors the
  `import_jobs` pattern, with a `suppressed` counter alongside sent/failed so the totals
  always reconcile (`sent + failed + suppressed = processed`) — a manager can tell a
  delivery failure from a deliberate skip.
- **Double-send guard** — a single atomic conditional UPDATE on `dispatch_status`
  (`not_sent -> sending`), never read-then-write. Two concurrent triggers race and exactly
  one wins; the loser gets a clear 422. A failed run releases the lock back to `not_sent`
  so it can genuinely be retried rather than being stuck on "sending" forever.
- **The live consent re-check runs per recipient at send time**, not from the frozen
  audience — anyone who became DNC, unsubscribed, hard-bounced, or converted elsewhere
  since approval is skipped and counted as suppressed. Email blocks on all three consent
  flags; calls block on `dnc` only.
- **Batched sending** — 50 per batch with a 200 ms gap (SRS 4.5.2). A single recipient
  failing is recorded against that recipient and never aborts the run.
- **Rendering** — merge variables (`{{first_name}}`, `{{company}}`, ...), auto-injected
  unsubscribe link, appended open pixel, and every outbound link rewritten through the
  click tracker. All lead-supplied values are HTML-escaped: lead data comes from uploaded
  CSVs, so a company name containing markup must never inject into the email body.
- **Conversion and unsubscribe are two-step (GET shows a form, POST acts).** Corporate
  mail scanners — Safe Links, AV gateways, spam filters — prefetch every link in an email
  before the recipient sees it. Found during review: with these as plain GETs, a scanner
  prefetch would have marked leads **Converted (billing the client for a conversion that
  never happened)** and silently unsubscribed prospects who never asked. A prefetch never
  issues a POST, which is exactly why RFC 8058 mandates POST for one-click unsubscribe.
  The open pixel and click redirect stay GET — prefetch inflation there is cosmetic and
  industry-standard, not a billing or consent problem.
- **`sent` means the provider accepted it.** `sentAt` is stamped only on acceptance, so a
  rejected send is reported as `attempted` but never inflates `sent` or the denominator of
  every rate the client is shown. (An earlier attempt at this filtered on `errorMessage`,
  which was wrong — the webhook also writes bounce reasons there, conflating "never sent"
  with "sent fine, bounced later". The test caught it.)
- **Tracking endpoints are public by necessity** (email clients carry no session), with
  the unguessable token as the only credential. They fail silently on a bad token — an
  invalid open still returns a pixel, an invalid click still redirects — so they can't be
  used as an enumeration oracle. Click redirects are restricted to `http(s)` targets.
- **Status transitions**: a send promotes to `Contacted`; a **click** promotes to
  `Qualified` (an open alone is too weak a signal); the dedicated "I'm interested" CTA
  promotes straight to `Converted` with no human confirmation — unlike a self-reported
  call outcome, the lead's own click can't be fabricated by the agency.
- **SendGrid webhook** — delivered / bounce / spamreport / open / click. A **hard bounce
  permanently suppresses that address for that client immediately**, per-lead, without
  waiting for any campaign-wide bounce-rate threshold; a soft bounce is recorded but never
  suppresses. A spam complaint suppresses as well as records.
- **Analytics** — the full funnel plus SRS 4.8.5 rates (delivery, open, CTR, CTOR, bounce,
  unsubscribe), the 4.10 alert thresholds surfaced as flags, and live billing.
- **Real SendGrid, or stub** — with `SENDGRID_API_KEY` set the service delivers for real;
  without it, it logs what it would have sent (including the body, so local flows like
  password reset stay usable). Switching is an environment change, never a code change.

## User management & notifications (built this pass)

Closing a real gap: until now there was **no way to create an Executive or a Client
portal user through the API at all** — every test created them by writing directly to the
database, which meant the Call engine was unreachable from a clean install.

- **`POST /users/executives`** — creates the account and emails credentials. A temporary
  password is generated if the manager doesn't supply one, built to satisfy the SRS
  password policy by construction rather than by retrying until it passes. It exists in
  memory only long enough to hash and send; only the hash is ever stored.
- **`POST /users/client-users`** — the read-only Client portal login (SRS 4.11), scoped
  to one client.
- **`GET /users/executives`** — the Team page (SRS 4.2.3): assigned campaigns, calls
  logged, and **open leads**, the last one surfaced specifically because deactivating an
  executive who still holds unworked leads strands them.
- **Deactivate / reactivate** — bumps `tokenVersion`, so an already-issued access token
  stops working *immediately* rather than lingering until it expires.
- **`POST /users/:id/reset-password`** — issues the same single-use token as the
  self-service flow, so the manager never learns the user's password.

**All nine SRS 4.10 notifications** now exist and are wired to real call sites: manager
welcome, executive credentials, client portal credentials, executive assigned, campaign
launched, email campaign completed, call campaign completed, and the >10% bounce / >5%
unsubscribe alerts. They live in one `notification.service.js` rather than scattered
`sendEmail` calls, and **none of them throw** — a notification is a side-effect of a
business action, never the point of it, so a mail outage can't stop an executive being
created.

Two things this pass also completed by necessity:

- **Call campaigns now auto-complete by exhaustion.** The rule was designed long ago but
  nothing implemented it — a fully-worked campaign would have sat as `active` forever
  waiting for a manager to close it by hand. Now checked at the moment a queue runs dry,
  which is the only point the system knows it happened.
- **An intermittent bug found by repeat-running the suite.** Generated passwords draw
  from a symbol set including `&`, which the notification correctly HTML-escapes to
  `&amp;`. The test read the raw log and extracted the escaped form, so the executive
  login failed — but only when the generator happened to pick `&`, roughly 4 runs in 10.
  The escaping was right; the test needed to decode entities. Verified with six
  consecutive clean runs, since a single pass would have proved nothing.

## Client Portal (built this pass)

The read-only portal (SRS 4.11) — the last piece of the business story, letting a client
finally see what they're paying for.

- **`GET /portal/dashboard`** — aggregate totals across every campaign run for this client:
  campaigns, leads targeted, emails sent, calls logged, and qualified/converted counts.
  All figures are counts only, so they're shown in full — this is the "proof of effort and
  scale" the client is entitled to.
- **`GET /portal/campaigns`** — their campaign history (status, type, audience size), no
  lead identities.
- **Campaign detail and report downloads** reuse the existing report component, which was
  already role-aware — a client hitting `/reports/campaigns/:id` gets the same data
  redacted for their eyes.

**The visibility rule, and why it's one rule not two.** A client sees full aggregate
counts but individual lead *identities* only once a lead reaches Qualified or Converted —
they're buying qualified attention, not the agency's raw sourced list. Crucially, the
portal reuses the report component's exported `CLIENT_VISIBLE_STATUSES` constant rather
than defining its own, so the dashboard's "12 qualified" can never drift out of sync with
which 12 leads the downloadable report actually reveals. Everything is scoped to the
user's own `clientId` taken from their token, never from a request parameter.

Verified end to end: the dashboard's qualified/converted counts match exactly which leads
the client's own Excel export reveals; unqualified leads are withheld; internal call notes
never reach the client while the manager's export shows everything; and a client gets 404
on any other client's campaign. The redaction test was confirmed to genuinely fail when
redaction is deliberately broken — so it's a real guard, not a false green.

## Banner image upload (built this pass — final feature)

Direct browser-to-storage upload for email banners (SRS 4.7.2), via a presigned PUT.

- **`POST /uploads/banner-url`** — the manager requests a presigned upload URL for a
  banner. Ownership, campaign type (email only), draft status, content type (JPEG/PNG)
  and size (≤5MB) are all validated *before* a URL is issued, so a URL is only ever handed
  out for a legitimate upload.
- **The browser PUTs the file directly to storage**, never through the app server. With
  `STORAGE_DRIVER=s3` this is a real presigned S3 URL (the SDK presigner); with the local
  driver it's an app endpoint that stores the bytes — so the exact same browser flow
  (request URL → PUT file → use public URL) works with or without AWS.
- Keys follow the SRS layout `images/{campaignId}/{uuid}.{ext}`. The local
  receive/serve endpoints hard-constrain the key shape (no path injection) and cap size,
  since — like a presigned S3 URL — the unguessable key is the capability.
- The stored public URL is embedded as an `<img>` at the top of the rendered email.

Verified end to end: presign → direct PUT → served back with matching bytes → attached to
the campaign → rendered in the email; plus the type/size/ownership/draft-only/path-injection
guards.

## Project status: feature-complete against the SRS

Every functional requirement in the SRS is now built and tested:

| Area | Status |
|---|---|
| Auth (JWT, refresh, lockout, reset, token revocation, rate limiting) | Done |
| Client management | Done |
| Executive & client-portal user management + credential emails | Done |
| Lead import (async jobs, S3-ready storage, dedup, error files) | Done |
| Campaigns (segmentation, freeze, approval, multi-executive, sequences) | Done |
| Call engine (queue, live consent re-check, confirmation gate, callbacks, exhaustion) | Done |
| Email engine (async dispatch, tracking, SendGrid, hard-bounce suppression, analytics) | Done |
| All 9 SRS 4.10 notifications | Done |
| Reporting (PDF via PDFKit, Excel via ExcelJS, client redaction) | Done |
| Client Portal (dashboard, campaign list, redacted downloads) | Done |
| Banner image upload (presigned direct-to-storage) | Done |
| Two microservices, Docker, AWS-ready storage abstraction | Done |

**302 integration-test assertions across 9 suites**, all passing on a fresh database,
verified across two consecutive full runs.

Deliberately scoped out, as agreed and documented throughout: Amazon SQS (the SRS itself
marks it optional), an automated cadence engine (sequences are manager-driven by design),
and per-device refresh tokens.
