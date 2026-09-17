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

// The import API is asynchronous now: it returns a job id, and the caller
// polls until the job reaches a terminal state — exactly as the UI does.
async function importAndWait(form, auth, BASE_URL) {
  const startRes = await fetch(`${BASE_URL}/leads/import`, { method: 'POST', headers: auth, body: form });
  const started = await startRes.json();
  if (!started.data || !started.data.id) return { startStatus: startRes.status, data: started };
  const terminal = ['completed', 'completed_with_errors', 'failed'];
  const deadline = Date.now() + 15000;
  let last = started.data;
  while (Date.now() < deadline) {
    const r = await fetch(`${BASE_URL}/leads/imports/${started.data.id}/status`, { headers: auth });
    last = (await r.json()).data;
    if (terminal.includes(last.status)) break;
    await new Promise((res) => setTimeout(res, 250));
  }
  return { startStatus: startRes.status, data: last };
}

function spawnService(cwd, logFile) {
  const out = fs.openSync(logFile, 'w');
  return spawn('node', ['app/server.js'], {
    cwd: path.resolve(__dirname, cwd),
    stdio: ['ignore', out, out]
  });
}

async function main() {
  const apiLog = '/tmp/test_api.log';
  const uploadLog = '/tmp/test_upload.log';
  const emailLog = '/tmp/test_email.log';

  const api = spawnService('leadpulse-api', apiLog);
  const upload = spawnService('leadpulse-upload-service', uploadLog);
  const email = spawnService('leadpulse-email-service', emailLog);

  await new Promise((r) => setTimeout(r, 2500));
  console.log('--- API log so far ---');
  console.log(fs.readFileSync(apiLog, 'utf8'));

  try {
    // ============================================================
    // AUTH
    // ============================================================
    await fetch(`${BASE}/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        firstName: 'Asha',
        lastName: 'Rao',
        email: 'asha@acme-agency.com',
        password: 'Str0ng!Pass',
        confirmPassword: 'Str0ng!Pass'
      })
    });

    const loginRes = await fetch(`${BASE}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'asha@acme-agency.com', password: 'Str0ng!Pass' })
    });
    const login = await loginRes.json();
    check('login succeeds', loginRes.status === 200 && login.success, login);
    const token = login.data.accessToken;
    const authHeaders = { Authorization: `Bearer ${token}` };

    await fetch(`${BASE}/auth/forgot-password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'asha@acme-agency.com' })
    });
    await new Promise((r) => setTimeout(r, 500));
    const emailLogContent = fs.readFileSync(emailLog, 'utf8');
    check('Reset link was dispatched via the EMAIL microservice log (not the main API)', emailLogContent.includes('reset-password?token='), {
      emailLogContent
    });

    // ============================================================
    // CLIENT A: Acme Corp
    // ============================================================
    const clientARes = await fetch(`${BASE}/clients`, {
      method: 'POST',
      headers: { ...authHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Acme Corp', contactPerson: 'Mark', contactEmail: 'mark@acme.com' })
    });
    const clientA = await clientARes.json();
    check('Client A (Acme) created', clientARes.status === 201, clientA);
    const clientAId = clientA.data.id;

    // ============================================================
    // CLIENT B: Globex — SAME manager, to test the shared-database behavior
    // ============================================================
    const clientBRes = await fetch(`${BASE}/clients`, {
      method: 'POST',
      headers: { ...authHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Globex Inc', contactPerson: 'Sue', contactEmail: 'sue@globex.com' })
    });
    const clientB = await clientBRes.json();
    check('Client B (Globex) created', clientBRes.status === 201, clientB);
    const clientBId = clientB.data.id;

    // ============================================================
    // IMPORT into Client A's list
    // ============================================================
    const csvA = fs.readFileSync(path.resolve(__dirname, 'sample_leads_a.csv'));
    const formA = new FormData();
    formA.append('clientId', clientAId);
    formA.append('leadListName', 'Acme — Product A Prospects');
    formA.append('file', new Blob([csvA], { type: 'text/csv' }), 'sample_leads_a.csv');

    const importA = await importAndWait(formA, authHeaders, BASE);
    check(
      'Import A: all 3 leads are newToAgency (first time anyone has seen them)',
      importA.startStatus === 202 && importA.data.newToAgency === 3 && importA.data.failedRows === 0,
      importA
    );
    const listAId = importA.data.leadListId;

    // ============================================================
    // KEY TEST: import the same CSV into Client B's (Globex) list.
    // These people already exist globally — this should count as
    // "matchedFromAgencyDatabase", not "newToAgency".
    // ============================================================
    const formB = new FormData();
    formB.append('clientId', clientBId);
    formB.append('leadListName', 'Globex — Product X Prospects');
    formB.append('file', new Blob([csvA], { type: 'text/csv' }), 'sample_leads_a.csv');

    const importB = await importAndWait(formB, authHeaders, BASE);
    check(
      'Import into Client B: all 3 leads matchedFromAgencyDatabase (known globally, new to THIS client)',
      importB.startStatus === 202 && importB.data.matchedFromAgencyDatabase === 3 && importB.data.newToAgency === 0,
      importB
    );
    const listBId = importB.data.leadListId;

    const leadsForA = await (await fetch(`${BASE}/leads?clientId=${clientAId}`, { headers: authHeaders })).json();
    const leadsForB = await (await fetch(`${BASE}/leads?clientId=${clientBId}`, { headers: authHeaders })).json();
    check('Client A sees exactly 3 leads', leadsForA.data.length === 3, leadsForA);
    check('Client B sees exactly 3 leads (same 3 people, separate mappings)', leadsForB.data.length === 3, leadsForB);

    const raviForA = leadsForA.data.find((l) => l.email === 'ravi.kumar@manufacturingco.com');
    const raviForB = leadsForB.data.find((l) => l.email === 'ravi.kumar@manufacturingco.com');
    check('Ravi has the SAME global lead id under both clients (one identity, two mappings)', raviForA.id === raviForB.id, {
      raviForA,
      raviForB
    });
    const raviId = raviForA.id;

    // ============================================================
    // RE-IMPORT CSV B into Client A's list
    // ============================================================
    const csvB = fs.readFileSync(path.resolve(__dirname, 'sample_leads_b.csv'));
    const formC = new FormData();
    formC.append('clientId', clientAId);
    formC.append('leadListId', listAId);
    formC.append('file', new Blob([csvB], { type: 'text/csv' }), 'sample_leads_b.csv');

    const importC = await importAndWait(formC, authHeaders, BASE);
    check(
      'Re-import: Ravi alreadyMappedToClient, Neha newToAgency',
      importC.data.alreadyMappedToClient === 1 && importC.data.newToAgency === 1,
      importC
    );

    const raviDetailRes = await fetch(`${BASE}/leads/${raviId}?clientId=${clientAId}`, { headers: authHeaders });
    const raviDetail = await raviDetailRes.json();
    check('Ravi contact info updated by re-import (jobTitle -> SVP Engineering)', raviDetail.data.jobTitle === 'SVP Engineering', raviDetail);

    // ============================================================
    // DNC isolation across clients
    // ============================================================
    const dncRes = await fetch(`${BASE}/leads/${raviId}/dnc`, {
      method: 'PATCH',
      headers: { ...authHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientId: clientAId, dnc: true })
    });
    const dncBody = await dncRes.json();
    check('DNC set for Ravi under Client A', dncRes.status === 200 && dncBody.data.dnc === true, dncBody);

    const raviUnderBRes = await fetch(`${BASE}/leads/${raviId}?clientId=${clientBId}`, { headers: authHeaders });
    const raviUnderB = await raviUnderBRes.json();
    check('DNC is per-client — Ravi still contactable under Client B despite DNC under Client A', raviUnderB.data.dnc === false, raviUnderB);

    // ============================================================
    // Ethical firewall — Client A's view must never leak Client B's list
    // ============================================================
    const raviUnderARes = await fetch(`${BASE}/leads/${raviId}?clientId=${clientAId}`, { headers: authHeaders });
    const raviUnderA = await raviUnderARes.json();
    const leaksGlobexList = raviUnderA.data.memberships.some((m) => m.leadListId === listBId);
    check("Ethical firewall: Client A's view of Ravi never shows Client B's list membership", !leaksGlobexList, raviUnderA);

    // ============================================================
    // Manual status override — independence across clients preserved
    // ============================================================
    const statusRes = await fetch(`${BASE}/leads/${raviId}/status`, {
      method: 'PATCH',
      headers: { ...authHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ leadListId: listAId, status: 'Qualified' })
    });
    const statusBody = await statusRes.json();
    check('Ravi manually promoted to Qualified in Client A list', statusRes.status === 200 && statusBody.data.status === 'Qualified', statusBody);

    const raviBAfterRes = await fetch(`${BASE}/leads/${raviId}?clientId=${clientBId}`, { headers: authHeaders });
    const raviBAfter = await raviBAfterRes.json();
    const membershipB = raviBAfter.data.memberships.find((m) => m.leadListId === listBId);
    check("Ravi is still New in Client B's list — unaffected by Client A's Qualified status", membershipB.status === 'New', membershipB);

    // ============================================================
    // Malformed rows still skipped cleanly
    // ============================================================
    const badCsv =
      'first_name,last_name,email,phone,company,job_title,industry,source\n,Smith,not-an-email,123,X,Y,Z,W\nGood,Lead,good@x.com,123,X,Y,Z,W\n';
    const formBad = new FormData();
    formBad.append('clientId', clientAId);
    formBad.append('leadListId', listAId);
    formBad.append('file', new Blob([badCsv], { type: 'text/csv' }), 'bad.csv');
    const badBody = await importAndWait(formBad, authHeaders, BASE);
    check('Malformed rows skipped with reasons, valid rows still imported', badBody.data.failedRows === 1 && badBody.data.newToAgency === 1, badBody);

    // ============================================================
    // Cross-tenant protection (different Manager entirely)
    // ============================================================
    await fetch(`${BASE}/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        firstName: 'Bob',
        lastName: 'Other',
        email: 'bob@rival-agency.com',
        password: 'Str0ng!Pass2',
        confirmPassword: 'Str0ng!Pass2'
      })
    });
    const bobLoginRes = await fetch(`${BASE}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'bob@rival-agency.com', password: 'Str0ng!Pass2' })
    });
    const bobLogin = await bobLoginRes.json();
    const bobToken = bobLogin.data.accessToken;
    const crossTenantRes = await fetch(`${BASE}/clients/${clientAId}`, { headers: { Authorization: `Bearer ${bobToken}` } });
    check("A different Manager gets 404 on another manager's client", crossTenantRes.status === 404);

    // ============================================================
    // Client.isActive enforcement
    // ============================================================
    const deactivateRes = await fetch(`${BASE}/clients/${clientAId}/deactivate`, {
      method: 'PATCH',
      headers: authHeaders
    });
    check('Client A deactivated successfully', deactivateRes.status === 200, await deactivateRes.json());

    const blockedForm = new FormData();
    blockedForm.append('clientId', clientAId);
    blockedForm.append('leadListId', listAId);
    blockedForm.append('file', new Blob([csvA], { type: 'text/csv' }), 'sample_leads_a.csv');
    const blockedImportRes = await fetch(`${BASE}/leads/import`, { method: 'POST', headers: authHeaders, body: blockedForm });
    check('Import blocked for a deactivated client (403)', blockedImportRes.status === 403, await blockedImportRes.json());

    const blockedListCreateRes = await fetch(`${BASE}/lead-lists`, {
      method: 'POST',
      headers: { ...authHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientId: clientAId, name: 'Should Be Blocked' })
    });
    check('New list creation blocked for a deactivated client (403)', blockedListCreateRes.status === 403, await blockedListCreateRes.json());

    const blockedDncRes = await fetch(`${BASE}/leads/${raviId}/dnc`, {
      method: 'PATCH',
      headers: { ...authHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientId: clientAId, dnc: false })
    });
    check('DNC change blocked for a deactivated client (403)', blockedDncRes.status === 403, await blockedDncRes.json());

    const blockedStatusRes = await fetch(`${BASE}/leads/${raviId}/status`, {
      method: 'PATCH',
      headers: { ...authHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ leadListId: listAId, status: 'Converted' })
    });
    check('Status change blocked for a deactivated client (403)', blockedStatusRes.status === 403, await blockedStatusRes.json());

    const readWhileInactiveRes = await fetch(`${BASE}/leads?clientId=${clientAId}`, { headers: authHeaders });
    check('Reading leads is STILL allowed for a deactivated client (200)', readWhileInactiveRes.status === 200);

    const reactivateRes = await fetch(`${BASE}/clients/${clientAId}/reactivate`, {
      method: 'PATCH',
      headers: authHeaders
    });
    const reactivateBody = await reactivateRes.json();
    check('Client A reactivated successfully', reactivateRes.status === 200 && reactivateBody.data.isActive === true, reactivateBody);

    const afterReactivateDncRes = await fetch(`${BASE}/leads/${raviId}/dnc`, {
      method: 'PATCH',
      headers: { ...authHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientId: clientAId, dnc: true })
    });
    check('DNC change works again immediately after reactivation', afterReactivateDncRes.status === 200);

    // ============================================================
    // Duplicate list name protection (case-insensitive reuse, not error)
    // ============================================================
    const dupList1Res = await fetch(`${BASE}/lead-lists`, {
      method: 'POST',
      headers: { ...authHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientId: clientBId, name: 'Duplicate Name Test' })
    });
    const dupList1 = await dupList1Res.json();

    const dupList2Res = await fetch(`${BASE}/lead-lists`, {
      method: 'POST',
      headers: { ...authHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientId: clientBId, name: 'duplicate name test' }) // different case
    });
    const dupList2 = await dupList2Res.json();

    check('Second create with same name (different case) reuses the existing list, same id', dupList1.data.id === dupList2.data.id, {
      dupList1,
      dupList2
    });

    const allListsForB = await (await fetch(`${BASE}/lead-lists?clientId=${clientBId}`, { headers: authHeaders })).json();
    const dupCount = allListsForB.data.filter((l) => l.name.toLowerCase() === 'duplicate name test').length;
    check('Only ONE list actually exists with that name, not two', dupCount === 1, allListsForB);

    // No Campaign/Call HTTP API exists yet, so this is tested directly
    // against the models.
    // ============================================================
    const dm = require('leadpulse-data-model');
    const managerUser = await dm.User.findOne({ where: { email: 'asha@acme-agency.com' } });
    const executive = await dm.User.create({
      role: 'executive',
      managerId: managerUser.id,
      firstName: 'Raj',
      lastName: 'Test',
      email: `raj-${Date.now()}@acme-agency.com`,
      passwordHash: 'x'
    });
    const confirmer = await dm.User.create({
      role: 'campaign_manager',
      firstName: 'Second',
      lastName: 'Confirmer',
      email: `confirmer-${Date.now()}@acme-agency.com`,
      passwordHash: 'x'
    });
    const testCampaign = await dm.Campaign.create({
      clientId: clientAId,
      leadListId: listAId,
      createdByUserId: managerUser.id,
      name: 'Test Campaign For Constraint Check',
      type: 'call',
      status: 'active',
      dispatchStatus: 'not_sent'
    });

    // call_remarks now hang off the frozen audience row (campaign_lead_id),
    // so a campaign_leads row must exist first — which is exactly the
    // integrity guarantee this change buys us.
    const cl1 = await dm.CampaignLead.create({ campaignId: testCampaign.id, leadId: raviId, queueStatus: 'pending' });

    await dm.CallRemark.create({
      campaignLeadId: cl1.id,
      executiveUserId: executive.id,
      callOutcome: 'Converted',
      conversionConfirmed: true,
      confirmedByUserId: confirmer.id,
      confirmedAt: new Date()
    });

    let secondConfirmFailed = false;
    try {
      await dm.CallRemark.create({
        campaignLeadId: cl1.id,
        executiveUserId: executive.id,
        callOutcome: 'Converted',
        conversionConfirmed: true,
        confirmedByUserId: confirmer.id,
        confirmedAt: new Date()
      });
    } catch (err) {
      secondConfirmFailed = err.name === 'SequelizeUniqueConstraintError' || /duplicate key/i.test(err.message);
    }
    check('DB rejects a SECOND confirmed conversion for the same frozen audience row — no double-billing', secondConfirmFailed);

    const secondCampaign = await dm.Campaign.create({
      clientId: clientAId,
      leadListId: listAId,
      createdByUserId: managerUser.id,
      name: 'Second Test Campaign',
      type: 'call',
      status: 'active',
      dispatchStatus: 'not_sent'
    });
    const cl2 = await dm.CampaignLead.create({ campaignId: secondCampaign.id, leadId: raviId, queueStatus: 'pending' });
    let secondCampaignConfirmSucceeded = true;
    try {
      await dm.CallRemark.create({
        campaignLeadId: cl2.id,
        executiveUserId: executive.id,
        callOutcome: 'Converted',
        conversionConfirmed: true,
        confirmedByUserId: confirmer.id,
        confirmedAt: new Date()
      });
    } catch (err) {
      secondCampaignConfirmSucceeded = false;
    }
    check(
      'A confirmed conversion for the SAME lead in a DIFFERENT campaign is still allowed (legitimate re-engagement)',
      secondCampaignConfirmSucceeded
    );

    let selfConfirmRejected = false;
    try {
      const otherLeadId = leadsForA.data.find((l) => l.id !== raviId).id;
      const cl3 = await dm.CampaignLead.create({ campaignId: secondCampaign.id, leadId: otherLeadId, queueStatus: 'pending' });
      await dm.CallRemark.create({
        campaignLeadId: cl3.id,
        executiveUserId: executive.id,
        callOutcome: 'Converted',
        conversionConfirmed: true,
        confirmedByUserId: executive.id, // same person — must be rejected
        confirmedAt: new Date()
      });
    } catch (err) {
      selfConfirmRejected = err.name === 'SequelizeDatabaseError' || /check constraint/i.test(err.message);
    }
    check('DB still rejects self-confirmation (confirmedByUserId === executiveUserId)', selfConfirmRejected);

    // Tri-state confirmation: a REJECTED conversion must be recordable with
    // a reviewer, timestamp and reason — previously impossible.
    let rejectionRecorded = false;
    try {
      const otherLeadId2 = leadsForA.data.find((l) => l.id !== raviId).id;
      const cl4 = await dm.CampaignLead.create({ campaignId: testCampaign.id, leadId: otherLeadId2, queueStatus: 'pending' });
      const rejected = await dm.CallRemark.create({
        campaignLeadId: cl4.id,
        executiveUserId: executive.id,
        callOutcome: 'Converted',
        conversionConfirmed: false,
        conversionRejectionReason: 'Customer has not actually purchased yet.',
        confirmedByUserId: confirmer.id,
        confirmedAt: new Date()
      });
      rejectionRecorded = rejected.conversionConfirmed === false && Boolean(rejected.conversionRejectionReason);
    } catch (err) {
      rejectionRecorded = false;
    }
    check('A REJECTED conversion can be recorded with reviewer + reason (tri-state)', rejectionRecorded);

    // Negative call duration must be rejected by the DB.
    let negativeDurationRejected = false;
    try {
      const usedInSecond = (await dm.CampaignLead.findAll({ where: { campaignId: secondCampaign.id }, attributes: ['leadId'] })).map((r) => r.leadId);
      const freeLead = leadsForA.data.find((l) => !usedInSecond.includes(l.id));
      const cl5 = await dm.CampaignLead.create({ campaignId: secondCampaign.id, leadId: freeLead.id, queueStatus: 'pending' });
      await dm.CallRemark.create({
        campaignLeadId: cl5.id,
        executiveUserId: executive.id,
        callOutcome: 'Answered',
        callDurationMinutes: -5
      });
    } catch (err) {
      negativeDurationRejected = /check constraint/i.test(err.message);
    }
    check('DB rejects a negative call duration', negativeDurationRejected);

    console.log(`\n=== RESULTS: ${pass} passed, ${fail} failed ===`);
  } catch (err) {
    console.error('TEST RUNNER ERROR:', err);
    fail++;
    console.log(`\n=== RESULTS: ${pass} passed, ${fail} failed ===`);
  } finally {
    api.kill('SIGKILL');
    upload.kill('SIGKILL');
    email.kill('SIGKILL');
    await new Promise((r) => setTimeout(r, 500));
    process.exit(fail > 0 ? 1 : 0);
  }
}

main();
