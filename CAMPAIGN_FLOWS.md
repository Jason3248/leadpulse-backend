# LeadPulse — Campaign Flows in Full

Everything that can happen in an email campaign and a call campaign: every
state transition, every outcome, every table written, and the reasoning behind
each design decision. Written so you can defend any part of it.

---

## Part 1 — The four tables that hold campaign state

Understand these four and the rest follows.

| Table | Answers | Scope | Written by |
|---|---|---|---|
| `client_leads` | **"May we contact this person?"** | one row per (client, lead) | DNC toggle, unsubscribe, bounce/spam webhook |
| `lead_list_memberships` | **"How far along are they?"** | one row per (list, lead) | automatic transitions + manual override |
| `campaign_leads` | **"Were they in scope for this run?"** | one row per (campaign, lead) | only at `approve` |
| `lead_engagements` | **"What happened to this one email?"** | one row per (campaign_lead) per send | tracking endpoints + webhook |

Two independent axes, and keeping them separate is what makes the system
coherent:

- **Consent** (`client_leads`) — *may* we contact them. Absolute. Survives
  across every campaign that client runs.
- **Status** (`lead_list_memberships`) — *how interested* are they. Per product
  list. Revisable.

A lead can legitimately be `Qualified` **and** unsubscribed at the same time:
they showed real interest once, then asked to stop. Both facts are true.

---

## Part 2 — The shared lifecycle (before either channel diverges)

### 2.1 Import
Each CSV row resolves in three tiers:

1. **`leads`** — global identity, matched by email. Same person imported for two
   different clients is **one** row.
2. **`client_leads`** — this client's relationship. Created if new to them.
   Consent flags live here and are **never** touched by a re-import.
3. **`lead_list_memberships`** — status in this list, starting at `New`. A
   re-import **never resets** an existing member's status.

The import summary distinguishes three cases, which matters commercially:
- `newToAgency` — nobody has ever sourced this person
- `matchedFromAgencyDatabase` — the agency knew them (from another client's
  work), now newly mapped to this client
- `alreadyMappedToThisClient` — a straightforward re-upload

> **Deliberate limitation:** the agency's shared lead database means a later
> import can overwrite a name/title attached by an earlier one. That's usually
> desirable (fresher data), but it's a real trade-off of the shared model.

### 2.2 Campaign creation (draft)
Nothing is frozen. `segmentationFilters` is a *description* of who to target,
not a resolved list. The campaign can be freely edited.

### 2.3 Approval — **the freeze**
The single most important transition.

1. Segmentation resolves **once** against `lead_list_memberships`
2. `exclude_closed_leads` (default `true`) drops `Converted`/`Dead`
3. Firmographic filters (industry / jobTitle / source) apply
4. One `campaign_leads` row is written per matching lead
5. **Call only:** leads are round-robin split across assigned executives, each
   `queue_status: pending`
6. Status → `active`

**Why freeze:** without it, editing a lead's industry — or a new import landing
in the same list — would silently change who a live campaign targets. The
manager approved *one* audience; that's what must run.

**What is NOT frozen:** consent. It's re-checked live at the moment of each
contact (Part 5). So an opt-out *after* approval is still honoured.

---

## Part 3 — Email campaign, in full

### 3.1 Dispatch begins

**The double-send guard**, first:
```sql
UPDATE campaigns SET dispatch_status='sending'
WHERE id = ? AND dispatch_status='not_sent'
```
Exactly one caller gets `1 row affected`. A simultaneous second click gets `0`
and a **422**. A read-then-write check would leave a window where both pass —
this cannot.

Then an `email_dispatch_jobs` row is created and **202** returns immediately.
The send loop runs detached, in batches of 50 with a 200ms gap.

### 3.2 Per recipient, in exact order

1. **Live consent re-check** — blocked if `dnc` OR `isUnsubscribed` OR
   `isHardBounced`; also blocked if already `Converted`/`Dead` **unless** the
   campaign set `excludeClosedLeads: false`. Blocked → counted as
   **`suppressed`**, no email, **no engagement row at all**.
2. Generate a 24-byte hex **tracking token** (unique per recipient per campaign).
3. Create the `lead_engagements` row — `status: sent`, but **`sentAt` is NOT
   stamped yet**.
4. **Render** for this specific person:
   - merge variables substituted, every value **HTML-escaped** (lead data comes
     from uploaded CSVs — a company name containing markup must not inject)
   - every `http(s)` link rewritten through `/track/click`
   - banner `<img>` prepended if set
   - unsubscribe link auto-injected if the author didn't include one
   - 1×1 open pixel appended
5. Hand to the email service.
   - **Accepted** → stamp `sentAt`, promote status to `Contacted`
   - **Rejected** → count `failed`, record `errorMessage`, **continue the batch**

**The counters always reconcile: `sent + failed + suppressed = processed`.**
That's why `suppressed` is first-class — otherwise "deliberately skipped" would
be indistinguishable from "delivery failed".

### 3.3 Why `sentAt` defines "sent"

A row exists before the provider is called. `sentAt` is stamped **only on
acceptance**. So analytics count sent as `sentAt IS NOT NULL` — a rejected send
appears as *attempted* but never inflates *sent* or any rate derived from it.

> An earlier version filtered on `errorMessage IS NULL` instead. That was wrong:
> the webhook also writes **bounce reasons** to `errorMessage`, so a delivered
> email that later bounced was being counted as "never sent". Caught by a test.

### 3.4 Engagement events (asynchronous, after the send)

| Event | Engagement row | Status change | Consent change |
|---|---|---|---|
| **Open** (pixel) | `openedAt` (first), `openCount++` | **none** | none |
| **Click** (redirect) | `clickedAt` (first), `clickCount++` | → **Qualified** | none |
| **Convert** (CTA POST) | `convertedAt`, `clickedAt`, `clickCount++` | → **Converted** | none |
| **Unsubscribe** (POST) | `unsubscribedAt` | **none** | `isUnsubscribed = true` |

**Why an open doesn't promote:** images auto-load, previews fire, scanners
prefetch. An open is too weak a signal to mean interest. A **click** is a
deliberate act — that's the MQL threshold.

**Why the CTA needs no human confirmation:** unlike a self-reported call
outcome, the lead's own click cannot be fabricated by anyone at the agency.

### 3.5 The GET-page / POST-action split (a real safeguard)

`/track/convert` and `/track/unsubscribe` both have a **GET that renders a form
and writes nothing**, and a **POST that acts**.

Corporate mail security scanners (Outlook Safe Links, AV gateways, spam filters)
**prefetch every link in an email** before the recipient sees it. If a GET
converted, a scanner would mark leads Converted and the **client would be billed
for conversions that never happened**. If a GET unsubscribed, legitimate
prospects would be silently suppressed.

A prefetch never issues a POST. This is exactly why RFC 8058 mandates POST for
one-click unsubscribe.

The open pixel and click redirect stay GET — prefetch inflation there is
cosmetic, not a billing or consent problem.

### 3.6 The provider webhook

| Event | Engagement | `client_leads` |
|---|---|---|
| `delivered` | `status: delivered`, `deliveredAt` | — |
| `bounce` (hard) | `status: bounced`, `bounceType: hard` | **`isHardBounced = true`** |
| `bounce` (`type: blocked`) | `status: bounced`, `bounceType: soft` | **untouched** |
| `spamreport` | `status: spamreport` | `isUnsubscribed = true` |
| `open` / `click` | mirrors 3.4 | — |

**Hard bounce suppresses immediately, per-lead, with no threshold.** A dead
address is dead regardless of how the rest of the campaign performed. The
campaign-wide >10% bounce alert is a *separate* signal to the manager about list
quality — the two must not be conflated.

**Soft bounce deliberately does not suppress** — a full mailbox is "try later",
not "gone".

---

## Part 4 — Call campaign, in full

### 4.1 Serving the queue

`GET /call/campaigns/:id/next` returns the oldest lead in **this executive's own
slice** with `queue_status` in (`pending`, `in_progress`, `called`).

Before returning it, the **live consent check** runs — for calls this blocks on
`dnc` **only**. An email unsubscribe is *not* a "don't phone me" signal, and
treating it as one would wrongly shrink call audiences.

A lead who fails the check is set to `skipped` on the spot and the loop moves
on, invisibly to the executive.

The Call Card includes **previous remarks on this lead in this campaign**, so a
re-call is never made blind.

### 4.2 Every outcome, exactly

| Outcome | `queue_status` → | Membership status → | Re-servable? |
|---|---|---|---|
| Not Answered / Busy / Left Voicemail / Answered | `called` | → `Contacted` | **Yes** |
| Wrong Number | `completed` | unchanged | No |
| **Not Interested** | `completed` | → **`Dead`** (automatic) | No |
| **Callback Requested** | `in_progress` | unchanged | **Yes** |
| **Converted** | `completed` | **unchanged — pending review** | No |

Rules worth noting:
- `Callback Requested` **requires** `followUpDate`; supplying one on any other
  outcome is rejected. Both are 400s.
- `called` is deliberately **re-servable**. Not Answered/Busy are the most
  common real-world outcomes; if they were terminal, most leads would be
  stranded after one attempt and the campaign could never complete honestly.
- **Queue ordering is "least-recently-worked first":** `pending` (never
  attempted) leads are served first, then `called`/`in_progress` leads ordered
  by how long ago they were last worked. So a lead you just marked "Not
  Answered" drops to the **back** of the queue — the executive moves on to the
  next person and cycles back to it later, rather than being handed the same
  unreachable lead on every call. (An earlier version ordered purely by
  `addedAt`, which made the oldest unresolved lead "sticky" — it kept being
  served immediately until resolved. Fixed.)
- An executive may also pass `leadStatusUpdate` (Contacted/Qualified) to
  promote based on their judgement of the conversation.

### 4.3 Why "Not Interested" auto-marks Dead but email silence never does

An explicit human "no" on a call is a definite negative signal. Email silence is
not — it might be a full inbox, a spam folder, a bad subject line, or a busy
week. Treating silence as rejection would permanently kill leads who were never
actually reached.

### 4.4 The conversion confirmation gate

Logging `Converted` writes a `call_remarks` row and **nothing else**:
- the lead's status does **not** change
- **nothing is billed**

The claim sits in `/pending-conversions`. A manager then confirms or rejects.

- **Confirm** → status becomes `Converted`, billing ledger row written
- **Reject** → requires a reason; who rejected it and when are recorded; the
  lead stays workable

**Two database-enforced rules:**
1. `confirmed_by_user_id <> executive_user_id` — no self-approval
2. At most one confirmed conversion per `(campaign_lead)` — an accidental
   re-call can't double-bill the same person in the same campaign

**Why this exists:** a call outcome is *self-reported by staff*. Under
cost-per-lead pricing, that's a direct claim on the client's money. An email CTA
click needs no such gate because the lead generated it themselves.

### 4.5 Callbacks

A callback keeps the lead `in_progress` and **holds the whole campaign open**
until worked. `/callbacks-due` surfaces due/overdue ones — but only the
**latest** remark per lead counts, so a callback superseded by a later call
correctly drops off rather than lingering as a phantom.

Nothing forces resolution. An unresolved callback blocks auto-completion until
either it's worked or the manager ends the campaign early. That's honest rather
than automatic.

### 4.6 Completion

A call campaign auto-completes when **every** `campaign_leads` row across **all**
executives reaches `completed` or `skipped`. Ending early sweeps still-open rows
to `skipped` — which never touches the leads' own status.

---

## Part 5 — The live consent re-check (both channels)

Runs immediately before contact, **never** from the frozen snapshot.

| Condition | Blocks email? | Blocks call? |
|---|---|---|
| `dnc` | **Yes** | **Yes** |
| `isUnsubscribed` | **Yes** | No |
| `isHardBounced` | **Yes** | No |
| Status `Converted`/`Dead` | Yes¹ | Yes¹ |

¹ *Unless the campaign set `excludeClosedLeads: false` — a deliberate
re-engagement or thank-you step.*

**The asymmetry is the point.** DNC means "don't contact me" — absolute, both
channels. Unsubscribe and bounce are **email-specific**: someone who opted out
of emails may still be perfectly callable, and a dead email address says nothing
about their phone.

---

## Part 6 — Sequences and billing

### 6.1 Why the sequence is the billing unit

A client contracts for an outreach **motion** — "run a cadence against this
list" — not for individual sends. Billing per campaign would mean a lead who
converts once in a 3-step cadence could be charged up to three times.

So **pricing lives on `sequences`**. A campaign with a `sequenceId` reports
`billedAtSequenceLevel: true` and points at its sequence rather than showing its
own amount. Standalone campaigns (no `sequenceId`) keep their own pricing and
bill alone.

### 6.2 How "billed once per lead per sequence" is guaranteed

A `sequence_conversions` ledger with **`UNIQUE (sequence_id, lead_id)`**.

Every conversion — call or email, step 1 or step 5 — attempts an insert. The
first succeeds; any later one for the same lead in the same sequence is rejected
by the database. Billing counts **rows**, so double-billing is *structurally
impossible* rather than depending on someone remembering to write `DISTINCT`.

| Scenario | Billed |
|---|---|
| Converts at step 1 of a 3-step motion | **Once** |
| Converts at step 2, converts again on the step-3 thank-you | **Once** |
| Converts in sequence A, later converts in sequence B | **Twice** — separate engagements |
| Converts in a standalone campaign | Once, from that campaign's pricing |

### 6.3 The formulas

- `cost_per_lead`: `amount = billable_conversions × rate_per_lead`
- `flat_retainer`: `cost_per_conversion = retainer ÷ billable_conversions`
  (null at zero conversions, not a divide-by-zero)

"Billable" still means **confirmed**: a call conversion needs manager review
before reaching the ledger; an email conversion is auto-confirmed by the lead's
own click.

### 6.4 Deduplication in rollups

`uniqueLeadsReached` counts **distinct people**, not `campaign_leads` rows. A
person touched by three steps is **one** person reached.

> This was a real bug: counting rows made the portal report 106 leads targeted
> from a 100-person list. Fixed to count unique leads.

---

## Part 7 — What the client sees, and why

| Data | Client sees |
|---|---|
| Aggregate counts (reached, sent, calls, qualified, converted) | **Full, unredacted** |
| Contact details of `Qualified`/`Converted` leads | **Visible** |
| Contact details of `New`/`Contacted`/`Dead` leads | **`(withheld)`** |
| Internal call notes | **`(internal)` — never shown** |
| Another client's data | **404** |

**The reasoning:** the agency's sourced lead list is its own competitive asset.
If a client could see all 400 contacts from day one, nothing stops them
contacting everyone directly and cutting the agency out next cycle. What they're
buying — and what they receive — is *qualified attention*, not raw data.

Aggregate counts are still shown in full, because that's the proof of effort
they're paying for.

**One consequence worth knowing:** an unconfirmed call conversion shows to the
client as `Qualified`, not `Converted` — they never see an unverified claim
presented as a delivered result. That falls out of the confirmation gate
automatically.

---

## Part 8 — Complete worked example

Client **Acme**, list **Q3 Prospects** (4 leads: Ann, Ben, Cat, Dan).
Sequence **"Q3 Outbound Motion"**, `cost_per_lead` at **$10**.

| # | Action | Result |
|---|---|---|
| 1 | Import 4 leads | all `New`, all contactable |
| 2 | Step 1 (email) approved | 4 `campaign_leads` rows frozen |
| 3 | Dispatch | 4 sent, 0 suppressed; all → `Contacted` |
| 4 | Ann opens | `openCount: 1`; status **unchanged** |
| 5 | Ann clicks the offer link | → **`Qualified`** |
| 6 | Ann clicks "I'm interested" | → **`Converted`**; ledger row #1; **$10** |
| 7 | Cat unsubscribes | `client_leads.isUnsubscribed = true`; status unchanged |
| 8 | Step 2 (call) targets `Qualified` | audience = 0 (Ann is now Converted, excluded by default) |
| 8b | …or targets `Contacted` | audience = Ben + Dan (Cat excluded? **no** — unsubscribe doesn't block calls) |
| 9 | Raj calls Ben → "Converted" | **nothing billed yet**; status unchanged |
| 10 | Manager confirms | Ben → `Converted`; ledger row #2; **$20** |
| 11 | Raj calls Dan → "Not Interested" | Dan → **`Dead`** automatically |
| 12 | Step 3 (thank-you email), `excludeClosedLeads: false`, targets `Converted` | audience = Ann + Ben; **emails send** |
| 13 | Ann clicks the CTA **again** | ledger insert **rejected**; **still $20** |
| 14 | Sequence rollup | 4 unique reached, 2 converted, **$20** |
| 15 | Client portal | sees 4 reached / 2 converted / $20; Ann & Ben's details visible; Cat & Dan `(withheld)` |

Every number above is verified by the automated suite (`test-sequence.js`).

---

## Part 9 — Known, deliberate limitations

Stated rather than hidden — each was a considered trade-off:

1. **Executive deactivation doesn't auto-reassign** their unresolved leads. The
   manager is expected to reassign first; the Team page surfaces an `openLeads`
   count precisely so they can see this before acting.
2. **One refresh token per user** — logging in on a new device ends the previous
   session's ability to renew. Concurrent multi-device sessions are out of scope.
3. **Sequences are manager-driven, not automated.** There's no scheduler firing
   step 2 three days after step 1; the manager creates each step when they judge
   the previous one has run its course. This models the *decision structure* of a
   cadence without building an autonomous cadence engine.
4. **Shared lead database means contact-field drift** — a later import for one
   client can update a name/title that another client's import set. Usually
   desirable (fresher data), but real.
5. **No cross-client visibility of shared leads** — deliberate. If two clients
   happen to target the same person, neither is told. This is an ethical
   firewall, not a missing feature.
6. **Tracking needs a public URL** to work with real inboxes (see the testing
   guide). Locally it's simulated by calling the tracking endpoints directly.
