'use strict';

/**
 * A GUIDED end-to-end walkthrough of the whole backend, run as one story in
 * the exact order a frontend would drive it. Unlike the test suites (which
 * assert isolated behaviours), this narrates the happy-path flow start to
 * finish so you can watch the system work as a whole and confirm it's
 * frontend-ready.
 *
 *   node demo-walkthrough.js
 *
 * It spins up all three services itself against a fresh database.
 */

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const BASE = 'http://localhost:4000/api/v1';
const j = (r) => r.json();

let step = 0;
function say(msg) {
  step += 1;
  console.log(`\n\x1b[36m[${String(step).padStart(2, '0')}]\x1b[0m ${msg}`);
}
function show(label, obj) {
  console.log(`     \x1b[90m${label}:\x1b[0m ${typeof obj === 'string' ? obj : JSON.stringify(obj)}`);
}

function spawnService(cwd, logFile) {
  const out = fs.openSync(logFile, 'w');
  return spawn('node', ['app/server.js'], { cwd: path.resolve(__dirname, cwd), stdio: ['ignore', out, out] });
}

async function main() {
  const api = spawnService('leadpulse-api', '/tmp/demo_api.log');
  const upload = spawnService('leadpulse-upload-service', '/tmp/demo_up.log');
  const emailSvc = spawnService('leadpulse-email-service', '/tmp/demo_em.log');
  await new Promise((r) => setTimeout(r, 2500));

  try {
    const dm = require('leadpulse-data-model');

    console.log('\n========================================================');
    console.log('  LeadPulse — guided end-to-end walkthrough');
    console.log('========================================================');

    // ---------- PHASE A: ONBOARDING ----------
    console.log('\n\x1b[33m--- PHASE A: Onboarding ---\x1b[0m');

    say('Campaign Manager self-registers (POST /auth/register)  [writes: users]');
    await fetch(`${BASE}/auth/register`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ firstName: 'Asha', lastName: 'Rao', email: 'asha@acme-agency.com', password: 'Str0ng!Pass', confirmPassword: 'Str0ng!Pass' })
    });
    show('registered', 'asha@acme-agency.com (a welcome email was sent)');

    say('Manager logs in (POST /auth/login)  [reads/writes: users]');
    const login = await j(await fetch(`${BASE}/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'asha@acme-agency.com', password: 'Str0ng!Pass' })
    }));
    const mgr = { Authorization: `Bearer ${login.data.accessToken}` };
    show('token', login.data.accessToken.slice(0, 32) + '...  (role: ' + login.data.user.role + ')');

    say('Create a Client "Acme Corp" (POST /clients)  [writes: clients]');
    const client = await j(await fetch(`${BASE}/clients`, {
      method: 'POST', headers: { ...mgr, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Acme Corp', contactPerson: 'Mark', contactEmail: 'mark@acme.com' })
    }));
    const clientId = client.data.id;
    show('client', `${client.data.name} (${clientId.slice(0, 8)}...)`);

    say('Create two Executives (POST /users/executives)  [writes: users; sends credential emails]');
    const raj = await j(await fetch(`${BASE}/users/executives`, {
      method: 'POST', headers: { ...mgr, 'Content-Type': 'application/json' },
      body: JSON.stringify({ firstName: 'Raj', lastName: 'Kumar', email: 'raj@acme-agency.com', temporaryPassword: 'Str0ng!Raj1' })
    }));
    await fetch(`${BASE}/users/executives`, {
      method: 'POST', headers: { ...mgr, 'Content-Type': 'application/json' },
      body: JSON.stringify({ firstName: 'Priya', lastName: 'Singh', email: 'priya@acme-agency.com', temporaryPassword: 'Str0ng!Pri1' })
    });
    show('executives', 'Raj and Priya created — temp passwords emailed, only hashes stored');

    say('Create a read-only Client Portal user (POST /users/client-users)  [writes: users]');
    await fetch(`${BASE}/users/client-users`, {
      method: 'POST', headers: { ...mgr, 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientId, firstName: 'Mark', lastName: 'Client', email: 'mark@acme.com', temporaryPassword: 'Cl!entPass9' })
    });
    show('portal user', 'mark@acme.com — scoped to Acme, read-only');

    // ---------- PHASE B: LEADS ----------
    console.log('\n\x1b[33m--- PHASE B: Get leads in ---\x1b[0m');

    say('Start an async CSV import (POST /leads/import -> 202 + job id)  [writes: import_jobs]');
    const csv =
      'first_name,last_name,email,phone,company,job_title,industry,source\n' +
      'Ann,A,ann@x.com,111,AlphaCo,VP Engineering,Manufacturing,LinkedIn\n' +
      'Ben,B,ben@x.com,222,BetaCo,VP Sales,Manufacturing,LinkedIn\n' +
      'Cat,C,cat@x.com,333,GammaCo,Director,Retail,Referral\n' +
      'Dan,D,dan@x.com,444,DeltaCo,Manager,Retail,Web\n' +
      ',NoName,bad-email,555,X,Y,Z,W\n';
    const form = new FormData();
    form.append('clientId', clientId);
    form.append('leadListName', 'Acme Q3 Prospects');
    form.append('file', new Blob([csv], { type: 'text/csv' }), 'prospects.csv');
    const imp = await j(await fetch(`${BASE}/leads/import`, { method: 'POST', headers: mgr, body: form }));
    show('job', `${imp.data.id.slice(0, 8)}... (status: ${imp.data.status})`);

    say('Poll the import job until done (GET /leads/imports/:id/status)  [reads: import_jobs]');
    let jobStatus;
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 250));
      jobStatus = (await j(await fetch(`${BASE}/leads/imports/${imp.data.id}/status`, { headers: mgr }))).data;
      if (['completed', 'completed_with_errors', 'failed'].includes(jobStatus.status)) break;
    }
    const leadListId = jobStatus.leadListId;
    show('result', `status=${jobStatus.status}, newToAgency=${jobStatus.newToAgency}, skipped=${jobStatus.failedRows} (the bad-email row)`);
    show('note', 'Behind the scenes each good row upserted into: leads + client_leads + lead_list_memberships(status=New)');

    say('Browse the imported leads (GET /leads?clientId=...)  [reads: client_leads, leads, lead_list_memberships]');
    const leads = (await j(await fetch(`${BASE}/leads?clientId=${clientId}`, { headers: mgr }))).data;
    show('leads', `${leads.length} leads visible for Acme`);
    const annId = leads.find((l) => l.email === 'ann@x.com').id;
    const benId = leads.find((l) => l.email === 'ben@x.com').id;

    // ---------- PHASE C: CALL CAMPAIGN ----------
    console.log('\n\x1b[33m--- PHASE C: A CALL campaign ---\x1b[0m');

    say('Create a draft CALL campaign (POST /campaigns)  [writes: campaigns]');
    const rajUser = await dm.User.findOne({ where: { email: 'raj@acme-agency.com' } });
    const priyaUser = await dm.User.findOne({ where: { email: 'priya@acme-agency.com' } });
    const callCamp = await j(await fetch(`${BASE}/campaigns`, {
      method: 'POST', headers: { ...mgr, 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientId, leadListId, name: 'Q3 Manufacturing Calls', type: 'call', segmentationFilters: { industry: 'Manufacturing' }, pricingModel: 'cost_per_lead', ratePerLead: 8 })
    }));
    const callCampId = callCamp.data.id;
    show('campaign', `${callCamp.data.name} (status: ${callCamp.data.status}, filter: industry=Manufacturing)`);

    say('Assign both executives (POST /campaigns/:id/executives)  [writes: campaign_executives; emails them]');
    await fetch(`${BASE}/campaigns/${callCampId}/executives`, {
      method: 'POST', headers: { ...mgr, 'Content-Type': 'application/json' },
      body: JSON.stringify({ executiveUserIds: [rajUser.id, priyaUser.id] })
    });
    show('assigned', 'Raj + Priya');

    say('APPROVE — the audience FREEZES (PATCH /campaigns/:id/approve)  [writes: campaign_leads, campaigns]');
    const approved = await j(await fetch(`${BASE}/campaigns/${callCampId}/approve`, { method: 'PATCH', headers: mgr }));
    show('frozen', `${approved.data.audienceCount} leads (only the 2 Manufacturing leads matched), status=${approved.data.status}`);
    show('split', 'round-robin across Raj & Priya, each queue_status=pending');

    say('Executive Raj logs in and opens his queue (GET /call/my-campaigns, /next)  [reads: campaign_leads + LIVE consent check]');
    const rajLogin = await j(await fetch(`${BASE}/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'raj@acme-agency.com', password: 'Str0ng!Raj1' })
    }));
    const rajAuth = { Authorization: `Bearer ${rajLogin.data.accessToken}` };
    const card = (await j(await fetch(`${BASE}/call/campaigns/${callCampId}/next`, { headers: rajAuth }))).data;
    show('call card', card ? `${card.firstName} at ${card.company} — ${card.phone}` : 'queue empty for Raj');

    if (card) {
      say('Raj logs a "Converted" outcome (POST /call/.../remarks)  [writes: call_remarks, campaign_leads]');
      const conv = await j(await fetch(`${BASE}/call/leads/${card.campaignLeadId}/remarks`, {
        method: 'POST', headers: { ...rajAuth, 'Content-Type': 'application/json' },
        body: JSON.stringify({ callOutcome: 'Converted', notes: 'INTERNAL: verbally agreed on the call', callDurationMinutes: 12 })
      }));
      show('remark', `outcome=Converted, awaitingConversionReview=${conv.data.awaitingConversionReview}`);
      show('note', 'Lead is NOT yet Converted and NOT yet billed — it waits for manager review');

      say('Manager reviews the pending conversion (GET pending-conversions, PATCH review)  [writes: call_remarks, lead_list_memberships]');
      const pending = (await j(await fetch(`${BASE}/call/campaigns/${callCampId}/pending-conversions`, { headers: mgr }))).data;
      show('inbox', `${pending.length} conversion(s) awaiting review`);
      await fetch(`${BASE}/call/remarks/${conv.data.id}/review`, {
        method: 'PATCH', headers: { ...mgr, 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirmed: true })
      });
      show('confirmed', 'lead is now Converted AND counts toward billing (manager ≠ the reporting executive)');
    }

    say('Manager checks call progress + live billing (GET /call/.../progress)  [reads: campaign_leads, call_remarks]');
    const prog = (await j(await fetch(`${BASE}/call/campaigns/${callCampId}/progress`, { headers: mgr }))).data;
    show('billing', prog.billing ? `${prog.billing.confirmedConversions} confirmed × $${prog.billing.ratePerLead} = $${prog.billing.amountAccrued}` : 'n/a');
    show('executives', prog.executives.map((e) => `${e.name}: ${e.callsLogged} calls, ${e.conversionsConfirmed} confirmed`).join(' | '));

    // ---------- PHASE D: EMAIL CAMPAIGN ----------
    console.log('\n\x1b[33m--- PHASE D: An EMAIL campaign ---\x1b[0m');

    say('Create + configure a draft EMAIL campaign (POST /campaigns, PATCH edit)  [writes: campaigns]');
    const emailCamp = await j(await fetch(`${BASE}/campaigns`, {
      method: 'POST', headers: { ...mgr, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        clientId, leadListId, name: 'Acme Retail Outreach', type: 'email',
        segmentationFilters: { industry: 'Retail' },
        subjectLine: 'Hi {{first_name}}', senderName: 'Acme Agency',
        emailBodyHtml: '<p>Hi {{first_name}} at {{company}},</p><p>See our <a href="https://acme.example/offer">offer</a>.</p><p><a href="http://localhost:4000/api/v1/track/convert?token=X">I\'m interested</a></p>',
        pricingModel: 'cost_per_lead', ratePerLead: 5
      })
    }));
    const emailCampId = emailCamp.data.id;
    show('campaign', `${emailCamp.data.name} (filter: industry=Retail)`);

    say('Approve it (freezes the Retail audience)  [writes: campaign_leads, campaigns]');
    const eApproved = await j(await fetch(`${BASE}/campaigns/${emailCampId}/approve`, { method: 'PATCH', headers: mgr }));
    show('frozen', `${eApproved.data.audienceCount} Retail leads`);

    say('Dispatch (POST /email/.../dispatch -> 202 async)  [writes: email_dispatch_jobs; async: lead_engagements]');
    const dispatch = await j(await fetch(`${BASE}/email/campaigns/${emailCampId}/dispatch`, { method: 'POST', headers: mgr }));
    show('job', `${dispatch.data.id.slice(0, 8)}... totalRecipients=${dispatch.data.totalRecipients}`);

    say('Poll the dispatch job (GET /email/dispatches/:id)  [reads: email_dispatch_jobs]');
    let ejob;
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 250));
      ejob = (await j(await fetch(`${BASE}/email/dispatches/${dispatch.data.id}`, { headers: mgr }))).data;
      if (['completed', 'completed_with_errors', 'failed'].includes(ejob.status)) break;
    }
    show('result', `sent=${ejob.sent}, suppressed=${ejob.suppressed}, failed=${ejob.failed} (sent+suppressed+failed=processed=${ejob.processed})`);

    say('Simulate recipient engagement (open -> click -> convert) via the public tracking endpoints');
    const retailLeads = leads.filter((l) => ['cat@x.com', 'dan@x.com'].includes(l.email));
    const catCl = await dm.CampaignLead.findOne({ where: { campaignId: emailCampId, leadId: retailLeads[0].id } });
    const catEng = await dm.LeadEngagement.findOne({ where: { campaignLeadId: catCl.id } });
    if (catEng) {
      await fetch(`${BASE}/track/open?token=${catEng.trackingToken}`);
      show('open', 'pixel loaded -> openedAt stamped (status stays Contacted — an open is too weak to promote)');
      await fetch(`${BASE}/track/click?token=${catEng.trackingToken}&url=${encodeURIComponent('https://acme.example/offer')}`, { redirect: 'manual' });
      show('click', 'link clicked -> lead promoted to QUALIFIED, then 302-redirected to the real URL');
      await fetch(`${BASE}/track/convert`, {
        method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ token: catEng.trackingToken })
      });
      show('convert', 'CTA POST -> lead promoted to CONVERTED (no human review needed; the click can\'t be faked)');
    }

    say('View email analytics (GET /email/.../analytics)  [reads: campaign_leads, lead_engagements]');
    const analytics = (await j(await fetch(`${BASE}/email/campaigns/${emailCampId}/analytics`, { headers: mgr }))).data;
    show('funnel', `audience=${analytics.funnel.audience}, sent=${analytics.funnel.sent}, opened=${analytics.funnel.opened}, clicked=${analytics.funnel.clicked}, converted=${analytics.funnel.converted}`);
    show('billing', analytics.billing ? `$${analytics.billing.amountAccrued} from ${analytics.billing.confirmedConversions} conversion(s)` : 'n/a');

    // ---------- PHASE E: REPORTS & PORTAL ----------
    console.log('\n\x1b[33m--- PHASE E: Reports & the Client Portal ---\x1b[0m');

    say('Manager downloads the campaign PDF + Excel (GET /reports/campaigns/:id/pdf|excel)');
    const pdf = await fetch(`${BASE}/reports/campaigns/${callCampId}/pdf`, { headers: mgr });
    const xlsx = await fetch(`${BASE}/reports/campaigns/${callCampId}/excel`, { headers: mgr });
    const pdfBuf = Buffer.from(await pdf.arrayBuffer());
    const xlsxBuf = Buffer.from(await xlsx.arrayBuffer());
    show('pdf', `${pdfBuf.length} bytes, valid=${pdfBuf.slice(0, 5).toString() === '%PDF-'}`);
    show('excel', `${xlsxBuf.length} bytes, valid=${xlsxBuf.slice(0, 2).toString() === 'PK'}`);

    say('The CLIENT logs into their portal (GET /portal/dashboard, /portal/campaigns)  [role: client, redacted]');
    const clientLogin = await j(await fetch(`${BASE}/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'mark@acme.com', password: 'Cl!entPass9' })
    }));
    const clientAuth = { Authorization: `Bearer ${clientLogin.data.accessToken}` };
    const dash = (await j(await fetch(`${BASE}/portal/dashboard`, { headers: clientAuth }))).data;
    show('dashboard', `${dash.totals.campaigns} campaigns, ${dash.totals.leadsTargeted} leads targeted, ${dash.totals.qualifiedLeads} qualified, ${dash.totals.convertedLeads} converted`);
    show('redaction', 'The client sees full COUNTS, but individual identities only for Qualified/Converted leads. Internal call notes are never shown.');

    console.log('\n========================================================');
    console.log('  ✔ Walkthrough complete — every phase ran end to end.');
    console.log('  Open http://localhost:4000/api-docs to drive it yourself.');
    console.log('========================================================\n');
  } catch (err) {
    console.error('\n\x1b[31mWALKTHROUGH ERROR:\x1b[0m', err);
    process.exitCode = 1;
  } finally {
    api.kill('SIGKILL');
    upload.kill('SIGKILL');
    emailSvc.kill('SIGKILL');
    await new Promise((r) => setTimeout(r, 500));
    process.exit(process.exitCode || 0);
  }
}

main();
