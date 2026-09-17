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

/** Polls a job until it reaches a terminal state, exactly as the UI would. */
async function pollUntilTerminal(jobId, auth, timeoutMs = 15000) {
  const terminal = ['completed', 'completed_with_errors', 'failed'];
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    const res = await fetch(`${BASE}/leads/imports/${jobId}/status`, { headers: auth });
    last = (await res.json()).data;
    if (terminal.includes(last.status)) return last;
    await new Promise((r) => setTimeout(r, 300));
  }
  return last;
}

async function main() {
  const api = spawnService('leadpulse-api', '/tmp/imp_api.log');
  const upload = spawnService('leadpulse-upload-service', '/tmp/imp_upload.log');
  const emailSvc = spawnService('leadpulse-email-service', '/tmp/imp_email.log');
  await new Promise((r) => setTimeout(r, 3000));

  try {
    await fetch(`${BASE}/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        firstName: 'Asha', lastName: 'Rao', email: 'asha@acme-agency.com',
        password: 'Str0ng!Pass', confirmPassword: 'Str0ng!Pass'
      })
    });
    const login = await (await fetch(`${BASE}/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'asha@acme-agency.com', password: 'Str0ng!Pass' })
    })).json();
    const auth = { Authorization: `Bearer ${login.data.accessToken}` };

    const client = await (await fetch(`${BASE}/clients`, {
      method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Acme Corp' })
    })).json();
    const clientId = client.data.id;

    // ============================================================
    // Clean import — all rows valid
    // ============================================================
    const goodCsv = 'first_name,last_name,email,phone,company,job_title,industry,source\n' +
      'Ravi,Kumar,ravi@x.com,1,C1,VP,Manufacturing,Web\n' +
      'Priya,Singh,priya@x.com,2,C2,Director,Manufacturing,Web\n' +
      'John,Doe,john@x.com,3,C3,VP,Retail,Web\n';
    const f1 = new FormData();
    f1.append('clientId', clientId);
    f1.append('leadListName', 'Async Prospects');
    f1.append('file', new Blob([goodCsv], { type: 'text/csv' }), 'good.csv');

    const startRes = await fetch(`${BASE}/leads/import`, { method: 'POST', headers: auth, body: f1 });
    const started = await startRes.json();
    check('Import returns 202 immediately with a job id (not blocking)', startRes.status === 202 && Boolean(started.data.id), started);
    check('Job starts in a non-terminal state', ['uploaded', 'queued', 'processing'].includes(started.data.status), started.data);

    const done = await pollUntilTerminal(started.data.id, auth);
    check('Job reaches completed', done.status === 'completed', done);
    check('All 3 rows succeeded, none failed', done.successfulRows === 3 && done.failedRows === 0, done);
    check('Progress reaches 100%', done.progressPercentage === 100, done);
    check('Breakdown reports 3 newToAgency', done.newToAgency === 3, done);
    check('No error file for a clean import', done.hasErrorFile === false, done);
    check('Job resolved a leadListId', Boolean(done.leadListId), done);

    // Leads actually landed
    const leads = await (await fetch(`${BASE}/leads?clientId=${clientId}`, { headers: auth })).json();
    check('The 3 leads are queryable after async processing', leads.data.length === 3, { count: leads.data.length });

    // ============================================================
    // Import with bad rows — error file must be generated
    // ============================================================
    const mixedCsv = 'first_name,last_name,email,phone,company,job_title,industry,source\n' +
      'Good,One,good1@x.com,1,C,VP,Tech,Web\n' +
      'Bad,Email,not-an-email,2,C,VP,Tech,Web\n' +
      ',NoFirstName,nofirst@x.com,3,C,VP,Tech,Web\n';
    const f2 = new FormData();
    f2.append('clientId', clientId);
    f2.append('leadListName', 'Async Prospects');
    f2.append('file', new Blob([mixedCsv], { type: 'text/csv' }), 'mixed.csv');

    const start2 = await (await fetch(`${BASE}/leads/import`, { method: 'POST', headers: auth, body: f2 })).json();
    const done2 = await pollUntilTerminal(start2.data.id, auth);
    check('Job with bad rows reaches completed_with_errors', done2.status === 'completed_with_errors', done2);
    check('1 succeeded, 2 failed', done2.successfulRows === 1 && done2.failedRows === 2, done2);
    check('Error file is flagged as available', done2.hasErrorFile === true, done2);

    const errRes = await fetch(`${BASE}/leads/imports/${start2.data.id}/errors`, { headers: auth });
    const errText = await errRes.text();
    check('Error file downloads as CSV', errRes.status === 200 && errRes.headers.get('content-type').includes('csv'));
    check('Error file contains the rejected rows with reasons',
      errText.includes('not-an-email') && errText.includes('Missing or invalid email') && errText.includes('Missing first name'),
      { preview: errText.slice(0, 200) });

    // ============================================================
    // XLSX support
    // ============================================================
    const XLSX = require('xlsx');
    const ws = XLSX.utils.json_to_sheet([
      { first_name: 'Excel', last_name: 'Lead', email: 'excel@x.com', phone: '9', company: 'XL', job_title: 'CTO', industry: 'Tech', source: 'Web' }
    ]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
    const xlsxBuf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });

    const f3 = new FormData();
    f3.append('clientId', clientId);
    f3.append('leadListName', 'Excel List');
    f3.append('file', new Blob([xlsxBuf]), 'leads.xlsx');
    const start3 = await (await fetch(`${BASE}/leads/import`, { method: 'POST', headers: auth, body: f3 })).json();
    const done3 = await pollUntilTerminal(start3.data.id, auth);
    check('XLSX file imports successfully', done3.status === 'completed' && done3.successfulRows === 1, done3);

    // ============================================================
    // Import history
    // ============================================================
    const history = await (await fetch(`${BASE}/leads/imports?clientId=${clientId}`, { headers: auth })).json();
    check('Import history lists all 3 jobs', history.data.length === 3, { count: history.data.length });

    // ============================================================
    // Service auth: the import service must reject an untokened call
    // ============================================================
    const noToken = await fetch('http://localhost:4001/process-import/00000000-0000-0000-0000-000000000000', { method: 'POST' });
    check('Import service rejects a call with no service token (401)', noToken.status === 401);

    const badToken = await fetch('http://localhost:4001/process-import/00000000-0000-0000-0000-000000000000', {
      method: 'POST', headers: { 'x-service-token': 'wrong-secret' }
    });
    check('Import service rejects a wrong service token (401)', badToken.status === 401);

    // ============================================================
    // Health checks
    // ============================================================
    // --- stale job rescue ---------------------------------------------
    // Simulate an import service that died mid-file: a job left in
    // 'processing' with an old startedAt must be rescued on read, not
    // polled forever.
    const dm = require('leadpulse-data-model');
    const stale = await dm.ImportJob.create({
      clientId,
      startedByUserId: (await dm.User.findOne({ where: { role: 'campaign_manager' } })).id,
      originalFilename: 'stalled.csv',
      status: 'processing',
      startedAt: new Date(Date.now() - 45 * 60 * 1000) // 45 min ago
    });
    const staleRes = await (await fetch(`${BASE}/leads/imports/${stale.id}/status`, { headers: auth })).json();
    check('A job stuck in processing past the threshold is rescued as failed', staleRes.data.status === 'failed', staleRes.data);
    check('The rescued job explains itself and invites a retry', /retry/i.test(staleRes.data.failureReason || ''), staleRes.data);

    // A job that only just started must NOT be wrongly killed.
    const fresh = await dm.ImportJob.create({
      clientId,
      startedByUserId: (await dm.User.findOne({ where: { role: 'campaign_manager' } })).id,
      originalFilename: 'inflight.csv',
      status: 'processing',
      startedAt: new Date()
    });
    const freshRes = await (await fetch(`${BASE}/leads/imports/${fresh.id}/status`, { headers: auth })).json();
    check('A genuinely in-flight job is left alone', freshRes.data.status === 'processing', freshRes.data);

    const h1 = await fetch('http://localhost:4000/health');
    const h2 = await fetch('http://localhost:4001/health');
    const h3 = await fetch('http://localhost:4002/health');
    check('All three services expose an unauthenticated /health', h1.status === 200 && h2.status === 200 && h3.status === 200);

    // ============================================================
    // Cross-tenant: another manager can't read this job
    // ============================================================
    await fetch(`${BASE}/auth/register`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ firstName: 'Bob', lastName: 'X', email: 'bob@rival.com', password: 'Str0ng!Pass2', confirmPassword: 'Str0ng!Pass2' })
    });
    const bob = await (await fetch(`${BASE}/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'bob@rival.com', password: 'Str0ng!Pass2' })
    })).json();
    const cross = await fetch(`${BASE}/leads/imports/${started.data.id}/status`, {
      headers: { Authorization: `Bearer ${bob.data.accessToken}` }
    });
    check("Another manager gets 404 on someone else's import job", cross.status === 404);

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
