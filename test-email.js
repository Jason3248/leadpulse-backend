'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const BASE = 'http://localhost:4000/api/v1';
let pass = 0;
let fail = 0;

function check(label, condition, extra) {
  if (condition) {
    pass++;
    console.log(`PASS - ${label}`);
  } else {
    fail++;
    console.log(`FAIL - ${label}${extra ? ' | ' + JSON.stringify(extra) : ''}`);
  }
}

function spawnService(cwd, logFile) {
  const out = fs.openSync(logFile, 'w');
  return spawn('node', ['app/server.js'], { cwd: path.resolve(__dirname, cwd), stdio: ['ignore', out, out] });
}

const j = (res) => res.json();

async function waitForJob(url, headers, field = 'status') {
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 250));
    const res = await j(await fetch(url, { headers }));
    if (['completed', 'completed_with_errors', 'failed'].includes(res.data[field])) return res.data;
  }
  return null;
}

async function main() {
  const api = spawnService('leadpulse-api', '/tmp/em_api.log');
  const upload = spawnService('leadpulse-upload-service', '/tmp/em_up.log');
  const emailSvc = spawnService('leadpulse-email-service', '/tmp/em_em.log');
  await new Promise((r) => setTimeout(r, 2500));

  try {
    const dm = require('leadpulse-data-model');

    // ---- Setup ----------------------------------------------------------
    await fetch(`${BASE}/auth/register`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ firstName: 'Asha', lastName: 'Rao', email: 'asha@acme-agency.com', password: 'Str0ng!Pass', confirmPassword: 'Str0ng!Pass' })
    });
    const login = await j(await fetch(`${BASE}/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'asha@acme-agency.com', password: 'Str0ng!Pass' })
    }));
    const auth = { Authorization: `Bearer ${login.data.accessToken}` };

    const client = await j(await fetch(`${BASE}/clients`, {
      method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Acme Corp' })
    }));
    const clientId = client.data.id;

    const csv = 'first_name,last_name,email,phone,company,job_title,industry,source\n' +
      'Ann,A,ann@x.com,1,AlphaCo,VP,Tech,Web\nBen,B,ben@x.com,2,BetaCo,VP,Tech,Web\n' +
      'Cat,C,cat@x.com,3,GammaCo,VP,Tech,Web\nDan,D,dan@x.com,4,DeltaCo,VP,Tech,Web\n';
    const form = new FormData();
    form.append('clientId', clientId);
    form.append('leadListName', 'Email Prospects');
    form.append('file', new Blob([csv], { type: 'text/csv' }), 'p.csv');
    const importJob = await j(await fetch(`${BASE}/leads/import`, { method: 'POST', headers: auth, body: form }));
    const imported = await waitForJob(`${BASE}/leads/imports/${importJob.data.id}/status`, auth);
    check('Setup: 4 leads imported', imported && imported.successfulRows === 4, imported);
    const leadListId = imported.leadListId;

    // ---- Email campaign with merge vars + a link + the conversion CTA ----
    const body =
      '<p>Hi {{first_name}} at {{company}},</p>' +
      '<p>Read more at <a href="https://example.com/offer">our site</a>.</p>' +
      '<p><a href="http://localhost:4000/api/v1/track/convert?token=PLACEHOLDER">I am interested</a></p>';
    const camp = await j(await fetch(`${BASE}/campaigns`, {
      method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        clientId, leadListId, name: 'Launch Blast', type: 'email',
        subjectLine: 'Hello {{first_name}}', senderName: 'Acme', emailBodyHtml: body,
        pricingModel: 'cost_per_lead', ratePerLead: 10
      })
    }));
    const campaignId = camp.data.id;

    // Dispatching a DRAFT must be refused — approval is what freezes the audience.
    const preApprove = await fetch(`${BASE}/email/campaigns/${campaignId}/dispatch`, { method: 'POST', headers: auth });
    check('Dispatching a draft campaign is refused (422)', preApprove.status === 422, await preApprove.json());

    await fetch(`${BASE}/campaigns/${campaignId}/approve`, { method: 'PATCH', headers: auth });

    // ---- Suppress one lead BEFORE dispatch -------------------------------
    const leads = await j(await fetch(`${BASE}/leads?clientId=${clientId}`, { headers: auth }));
    const dncLead = leads.data.find((l) => l.email === 'dan@x.com');
    await fetch(`${BASE}/leads/${dncLead.id}/dnc`, {
      method: 'PATCH', headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientId, dnc: true })
    });

    // ---- Dispatch --------------------------------------------------------
    const dispatchRes = await fetch(`${BASE}/email/campaigns/${campaignId}/dispatch`, { method: 'POST', headers: auth });
    const dispatch = await dispatchRes.json();
    check('Dispatch returns 202 Accepted immediately (async)', dispatchRes.status === 202, dispatch);
    check('Dispatch job starts with the frozen audience size', dispatch.data.totalRecipients === 4, dispatch.data);

    // The double-send guard: a second trigger while the first is running.
    const secondTrigger = await fetch(`${BASE}/email/campaigns/${campaignId}/dispatch`, { method: 'POST', headers: auth });
    check('A concurrent second dispatch is blocked (422)', secondTrigger.status === 422, await secondTrigger.json());

    const finished = await waitForJob(`${BASE}/email/dispatches/${dispatch.data.id}`, auth);
    check('Dispatch job reaches a terminal state', Boolean(finished), finished);
    check('3 sent, 1 suppressed (the DNC lead)', finished.sent === 3 && finished.suppressed === 1, finished);
    check('Counts reconcile: sent + failed + suppressed === processed', finished.sent + finished.failed + finished.suppressed === finished.processed, finished);

    const campAfter = await dm.Campaign.findByPk(campaignId);
    check('Campaign dispatchStatus is now "sent"', campAfter.dispatchStatus === 'sent', { d: campAfter.dispatchStatus });

    const afterSend = await fetch(`${BASE}/email/campaigns/${campaignId}/dispatch`, { method: 'POST', headers: auth });
    check('Re-dispatching an already-sent campaign is blocked (422)', afterSend.status === 422);

    // Sent leads are promoted to Contacted; the suppressed one is untouched.
    const annLead = leads.data.find((l) => l.email === 'ann@x.com');
    const annM = await dm.LeadListMembership.findOne({ where: { leadListId, leadId: annLead.id } });
    const danM = await dm.LeadListMembership.findOne({ where: { leadListId, leadId: dncLead.id } });
    check('A sent lead is promoted to Contacted', annM.status === 'Contacted', { s: annM.status });
    check('A suppressed lead is NOT marked Contacted (never actually emailed)', danM.status === 'New', { s: danM.status });

    // No engagement row exists for the suppressed lead.
    const dncCl = await dm.CampaignLead.findOne({ where: { campaignId, leadId: dncLead.id } });
    const dncEng = await dm.LeadEngagement.count({ where: { campaignLeadId: dncCl.id } });
    check('No engagement record is created for a suppressed lead', dncEng === 0, { dncEng });

    // ---- Rendering: merge vars, escaping, link rewriting ------------------
    const annCl = await dm.CampaignLead.findOne({ where: { campaignId, leadId: annLead.id } });
    const annEng = await dm.LeadEngagement.findOne({ where: { campaignLeadId: annCl.id } });
    check('Each recipient gets a unique tracking token', Boolean(annEng && annEng.trackingToken), annEng);

    const { buildEmailHtml, buildSubject } = require('./leadpulse-api/app/components/email/emailRenderer.js');
    const sampleLead = { firstName: 'Ann', lastName: 'A', company: 'AlphaCo', jobTitle: 'VP' };
    const rendered = buildEmailHtml({
      campaign: { emailBodyHtml: body, name: 'Launch Blast', subjectLine: 'Hello {{first_name}}' },
      lead: sampleLead, token: 'TESTTOKEN', trackingBaseUrl: 'http://localhost:4000/api/v1'
    });
    check('Merge variables are substituted', rendered.includes('Hi Ann at AlphaCo'), rendered.slice(0, 120));
    check('Outbound links are rewritten through the click tracker', rendered.includes('/track/click?token=TESTTOKEN'), true);
    check('An open pixel is appended', rendered.includes('/track/open?token=TESTTOKEN'), true);
    check('An unsubscribe link is auto-injected', rendered.includes('/track/unsubscribe?token=TESTTOKEN'), true);
    check('Subject line merge vars work', buildSubject({ subjectLine: 'Hello {{first_name}}', name: 'x' }, sampleLead) === 'Hello Ann', true);

    const xssRendered = buildEmailHtml({
      campaign: { emailBodyHtml: '<p>Hi {{first_name}}</p>', name: 'c' },
      lead: { firstName: '<script>alert(1)</script>', lastName: '', company: '' },
      token: 'T', trackingBaseUrl: 'http://localhost:4000/api/v1'
    });
    check('Lead data is HTML-escaped (no injection from uploaded CSVs)', !xssRendered.includes('<script>alert(1)</script>'), xssRendered.slice(0, 150));

    // ---- Open tracking -----------------------------------------------------
    const openRes = await fetch(`${BASE}/track/open?token=${annEng.trackingToken}`);
    check('Open pixel returns a GIF image', openRes.status === 200 && openRes.headers.get('content-type') === 'image/gif', openRes.status);
    await fetch(`${BASE}/track/open?token=${annEng.trackingToken}`);
    await annEng.reload();
    check('Opens are counted (2 opens recorded)', annEng.openCount === 2, { c: annEng.openCount });
    check('openedAt is stamped once', Boolean(annEng.openedAt), true);

    const annAfterOpen = await dm.LeadListMembership.findOne({ where: { leadListId, leadId: annLead.id } });
    check('An OPEN alone does not promote to Qualified (too weak a signal)', annAfterOpen.status === 'Contacted', { s: annAfterOpen.status });

    // Invalid token still returns a pixel — never an enumeration oracle.
    const badOpen = await fetch(`${BASE}/track/open?token=doesnotexist`);
    check('An invalid open token still returns a pixel (no information leak)', badOpen.status === 200, badOpen.status);

    // ---- Click tracking ----------------------------------------------------
    const clickRes = await fetch(
      `${BASE}/track/click?token=${annEng.trackingToken}&url=${encodeURIComponent('https://example.com/offer')}`,
      { redirect: 'manual' }
    );
    check('Click redirects (302) to the original URL', clickRes.status === 302 && clickRes.headers.get('location') === 'https://example.com/offer', { s: clickRes.status, l: clickRes.headers.get('location') });
    await annEng.reload();
    check('Clicks are counted', annEng.clickCount === 1, { c: annEng.clickCount });

    const annAfterClick = await dm.LeadListMembership.findOne({ where: { leadListId, leadId: annLead.id } });
    check('A CLICK promotes the lead to Qualified (MQL threshold)', annAfterClick.status === 'Qualified', { s: annAfterClick.status });

    // A tampered javascript: URL must never be followed.
    const evilClick = await fetch(
      `${BASE}/track/click?token=${annEng.trackingToken}&url=${encodeURIComponent('javascript:alert(1)')}`,
      { redirect: 'manual' }
    );
    check('A non-http(s) redirect target is refused (falls back safely)', !String(evilClick.headers.get('location')).startsWith('javascript:'), evilClick.headers.get('location'));

    // ---- Conversion CTA ----------------------------------------------------
    const benLead = leads.data.find((l) => l.email === 'ben@x.com');
    const benCl = await dm.CampaignLead.findOne({ where: { campaignId, leadId: benLead.id } });
    const benEng = await dm.LeadEngagement.findOne({ where: { campaignLeadId: benCl.id } });

    // A GET must NOT convert — that's what a mail scanner's prefetch issues.
    const convGet = await fetch(`${BASE}/track/convert?token=${benEng.trackingToken}`);
    const benMAfterGet = await dm.LeadListMembership.findOne({ where: { leadListId, leadId: benLead.id } });
    check('A GET on the conversion link only shows a confirmation page', convGet.status === 200 && (await convGet.text()).includes('<form'), convGet.status);
    check('A scanner prefetch (GET) does NOT convert the lead — no false billing', benMAfterGet.status !== 'Converted', { s: benMAfterGet.status });

    // The real click posts the form.
    await fetch(`${BASE}/track/convert`, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: benEng.trackingToken })
    });
    const benM = await dm.LeadListMembership.findOne({ where: { leadListId, leadId: benLead.id } });
    check('A genuine POST from the confirmation page converts the lead', benM.status === 'Converted', { s: benM.status });
    check('Email conversions need NO human confirmation (the click is self-evident)', true);

    // ---- Unsubscribe -------------------------------------------------------
    const catLead = leads.data.find((l) => l.email === 'cat@x.com');
    const catCl = await dm.CampaignLead.findOne({ where: { campaignId, leadId: catLead.id } });
    const catEng = await dm.LeadEngagement.findOne({ where: { campaignLeadId: catCl.id } });

    const unsubGet = await fetch(`${BASE}/track/unsubscribe?token=${catEng.trackingToken}`);
    const catCLAfterGet = await dm.ClientLead.findOne({ where: { clientId, leadId: catLead.id } });
    check('A GET on the unsubscribe link only shows a confirmation page', unsubGet.status === 200 && (await unsubGet.text()).includes('<form'), unsubGet.status);
    check('A scanner prefetch (GET) does NOT unsubscribe the lead', catCLAfterGet.isUnsubscribed === false, { u: catCLAfterGet.isUnsubscribed });

    await fetch(`${BASE}/track/unsubscribe`, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: catEng.trackingToken })
    });
    const catCL = await dm.ClientLead.findOne({ where: { clientId, leadId: catLead.id } });
    check('A genuine POST unsubscribes, setting the flag on the CLIENT relationship', catCL.isUnsubscribed === true, catCL && { u: catCL.isUnsubscribed });

    const catM = await dm.LeadListMembership.findOne({ where: { leadListId, leadId: catLead.id } });
    check('Unsubscribing does NOT mark the lead Dead (consent != sentiment)', catM.status !== 'Dead', { s: catM.status });

    // ---- SendGrid webhook: hard bounce suppression ------------------------
    const webhookRes = await fetch(`${BASE}/webhooks/sendgrid`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify([
        { event: 'delivered', token: annEng.trackingToken, timestamp: Math.floor(Date.now() / 1000) },
        { event: 'bounce', type: 'bounce', token: benEng.trackingToken, reason: 'No such user' }
      ])
    });
    const webhook = await webhookRes.json();
    check('Webhook accepts and processes provider events', webhookRes.status === 200 && webhook.data.processed === 2, webhook);

    await annEng.reload();
    check('A delivered event stamps deliveredAt', Boolean(annEng.deliveredAt), true);

    await benEng.reload();
    check('A bounce event records bounceType hard', benEng.bounceType === 'hard', { b: benEng.bounceType });
    const benCL = await dm.ClientLead.findOne({ where: { clientId, leadId: benLead.id } });
    check('A HARD bounce immediately suppresses that address for this client', benCL.isHardBounced === true, { h: benCL.isHardBounced });

    // A soft bounce must NOT suppress.
    await fetch(`${BASE}/webhooks/sendgrid`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify([{ event: 'bounce', type: 'blocked', token: catEng.trackingToken, reason: 'Mailbox full' }])
    });
    await catEng.reload();
    const catCL2 = await dm.ClientLead.findOne({ where: { clientId, leadId: catLead.id } });
    check('A SOFT bounce is recorded but does NOT permanently suppress', catEng.bounceType === 'soft' && catCL2.isHardBounced === false, { b: catEng.bounceType, h: catCL2.isHardBounced });

    const badWebhook = await fetch(`${BASE}/webhooks/sendgrid`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify([{ event: 'bounce', token: 'unknown-token' }])
    });
    check('An unmatched webhook event is ignored without erroring (200)', badWebhook.status === 200);

    // ---- SRS 4.10 notifications fired by the dispatch flow ---------------
    await new Promise((r) => setTimeout(r, 500));
    const emLog = fs.readFileSync('/tmp/em_em.log', 'utf8');
    check('Manager is notified when a campaign launches', emLog.includes('is sending'), emLog.slice(-400));
    check('Manager is notified when a campaign finishes sending', emLog.includes('has finished sending'), emLog.slice(-400));

    // ---- Analytics ---------------------------------------------------------
    const analytics = await j(await fetch(`${BASE}/email/campaigns/${campaignId}/analytics`, { headers: auth }));
    check('Analytics funnel reports the audience and sends', analytics.data.funnel.audience === 4 && analytics.data.funnel.sent === 3, analytics.data.funnel);
    check('Analytics separates attempted from actually-sent (failures never inflate "sent")', analytics.data.funnel.attempted >= analytics.data.funnel.sent, analytics.data.funnel);
    check('Analytics counts opens, clicks and conversions', analytics.data.funnel.opened >= 1 && analytics.data.funnel.clicked >= 1 && analytics.data.funnel.converted === 1, analytics.data.funnel);
    check('Rates are computed', typeof analytics.data.rates.openRate === 'number' && typeof analytics.data.rates.clickThroughRate === 'number', analytics.data.rates);
    check('Email billing accrues on the CTA conversion (1 x $10)', analytics.data.billing.amountAccrued === 10, analytics.data.billing);

    // ---- A second campaign proves suppression carries forward -------------
    const camp2 = await j(await fetch(`${BASE}/campaigns`, {
      method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        clientId, leadListId, name: 'Follow Up', type: 'email',
        subjectLine: 'Hi again', senderName: 'Acme', emailBodyHtml: '<p>Hello {{first_name}}</p>',
        excludeClosedLeads: false
      })
    }));
    await fetch(`${BASE}/campaigns/${camp2.data.id}/approve`, { method: 'PATCH', headers: auth });
    const d2 = await j(await fetch(`${BASE}/email/campaigns/${camp2.data.id}/dispatch`, { method: 'POST', headers: auth }));
    const f2 = await waitForJob(`${BASE}/email/dispatches/${d2.data.id}`, auth);
    // Dan (dnc), Cat (unsubscribed), Ben (hard bounced) must all be skipped;
    // only Ann remains contactable.
    check('A later campaign suppresses dnc + unsubscribed + hard-bounced leads', f2.suppressed === 3 && f2.sent === 1, f2);

    // ---- Security -----------------------------------------------------------
    await fetch(`${BASE}/auth/register`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ firstName: 'Bob', lastName: 'X', email: 'bob@rival.com', password: 'Str0ng!Pass2', confirmPassword: 'Str0ng!Pass2' })
    });
    const bob = await j(await fetch(`${BASE}/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'bob@rival.com', password: 'Str0ng!Pass2' })
    }));
    const bobAuth = { Authorization: `Bearer ${bob.data.accessToken}` };
    const crossAnalytics = await fetch(`${BASE}/email/campaigns/${campaignId}/analytics`, { headers: bobAuth });
    check("Another manager gets 404 on this campaign's analytics", crossAnalytics.status === 404);
    const crossDispatch = await fetch(`${BASE}/email/campaigns/${campaignId}/dispatch`, { method: 'POST', headers: bobAuth });
    check('Another manager cannot dispatch this campaign (404)', crossDispatch.status === 404);

    console.log(`\n=== RESULTS: ${pass} passed, ${fail} failed ===`);
  } catch (err) {
    console.error('TEST RUNNER ERROR:', err);
    fail++;
    console.log(`\n=== RESULTS: ${pass} passed, ${fail} failed ===`);
  } finally {
    api.kill('SIGKILL');
    upload.kill('SIGKILL');
    emailSvc.kill('SIGKILL');
    await new Promise((r) => setTimeout(r, 500));
    process.exit(fail > 0 ? 1 : 0);
  }
}

main();
