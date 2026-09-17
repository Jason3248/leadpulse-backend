'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const BASE = 'http://localhost:4000/api/v1';
const EMAIL_LOG = '/tmp/usr_em.log';
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

// The credentials email HTML-escapes the password (correctly — it renders
// as the real character in a mail client). Reading it back out of the raw
// log therefore requires decoding those entities first, or a password
// containing '&' would be extracted wrong. This was an intermittent
// failure: it only bit when the random generator happened to pick '&'.
const decodeEntities = (v) =>
  v.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
   .replace(/&quot;/g, '"').replace(/&#39;/g, "'");
const emailLog = () => fs.readFileSync(EMAIL_LOG, 'utf8');
const sentTo = (email, subjectFragment) => {
  const log = emailLog();
  return log.split('\n').some((line) => line.includes(email) && line.includes(subjectFragment));
};

async function main() {
  const api = spawnService('leadpulse-api', '/tmp/usr_api.log');
  const upload = spawnService('leadpulse-upload-service', '/tmp/usr_up.log');
  const emailSvc = spawnService('leadpulse-email-service', EMAIL_LOG);
  await new Promise((r) => setTimeout(r, 2500));

  try {
    const dm = require('leadpulse-data-model');

    // ---- Manager registration should send a welcome email ---------------
    await fetch(`${BASE}/auth/register`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ firstName: 'Asha', lastName: 'Rao', email: 'asha@acme-agency.com', password: 'Str0ng!Pass', confirmPassword: 'Str0ng!Pass' })
    });
    await new Promise((r) => setTimeout(r, 400));
    check('A new manager receives a welcome email', sentTo('asha@acme-agency.com', 'Welcome to LeadPulse'), emailLog().slice(-300));

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

    // ---- Create an executive WITHOUT supplying a password ---------------
    const execRes = await fetch(`${BASE}/users/executives`, {
      method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ firstName: 'Raj', lastName: 'Kumar', email: 'raj@acme-agency.com' })
    });
    const exec = await execRes.json();
    check('Manager can create an executive', execRes.status === 201 && exec.data.role === 'executive', exec);
    check('The created executive is active by default', exec.data.isActive === true, exec.data);
    check('No password or hash is ever returned in the response', !JSON.stringify(exec.data).toLowerCase().includes('password'), exec.data);

    await new Promise((r) => setTimeout(r, 400));
    check('The executive receives a credentials email', sentTo('raj@acme-agency.com', 'Your LeadPulse account is ready'), emailLog().slice(-500));

    // Extract the generated temp password from the stub log and actually use it.
    const log = emailLog();
    const rajLine = log.split('\n').find((l) => l.includes('raj@acme-agency.com') && l.includes('Temporary password'));
    const match = rajLine && rajLine.match(/Temporary password:<\/strong>\s*([^<\s]+)/);
    const tempPassword = match ? decodeEntities(match[1]) : null;
    check('A temporary password is generated and emailed', Boolean(tempPassword), { rajLine: rajLine && rajLine.slice(0, 200) });

    const execLogin = await fetch(`${BASE}/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'raj@acme-agency.com', password: tempPassword })
    });
    const execLoginBody = await execLogin.json();
    check('The executive can actually log in with the emailed password', execLogin.status === 200, execLoginBody);
    const execAuth = { Authorization: `Bearer ${execLoginBody.data.accessToken}` };

    // Generated password must satisfy the SRS policy.
    check(
      'The generated password meets the policy (8+, upper, digit, special)',
      tempPassword.length >= 8 && /[A-Z]/.test(tempPassword) && /[0-9]/.test(tempPassword) && /[^A-Za-z0-9]/.test(tempPassword),
      { tempPassword }
    );

    // ---- Duplicate email -------------------------------------------------
    const dup = await fetch(`${BASE}/users/executives`, {
      method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ firstName: 'Other', lastName: 'Person', email: 'raj@acme-agency.com' })
    });
    check('A duplicate email is rejected (409)', dup.status === 409, await dup.json());

    // ---- Client portal user ---------------------------------------------
    const portalRes = await fetch(`${BASE}/users/client-users`, {
      method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientId, firstName: 'Mark', lastName: 'Client', email: 'mark@acme.com' })
    });
    const portal = await portalRes.json();
    check('Manager can create a client portal user', portalRes.status === 201 && portal.data.role === 'client', portal);
    check('The portal user is scoped to their client', portal.data.clientId === clientId, portal.data);
    await new Promise((r) => setTimeout(r, 400));
    check('The client portal user receives credentials', sentTo('mark@acme.com', 'campaign portal is ready'), emailLog().slice(-500));

    // A portal user cannot reach manager-only routes.
    const portalLine = emailLog().split('\n').find((l) => l.includes('mark@acme.com') && l.includes('Temporary password'));
    const portalPass = decodeEntities(portalLine.match(/Temporary password:<\/strong>\s*([^<\s]+)/)[1]);
    const portalLogin = await j(await fetch(`${BASE}/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'mark@acme.com', password: portalPass })
    }));
    const portalAuth = { Authorization: `Bearer ${portalLogin.data.accessToken}` };
    const portalForbidden = await fetch(`${BASE}/users/executives`, { headers: portalAuth });
    check('A client portal user cannot access manager routes (403)', portalForbidden.status === 403);

    // ---- Team listing ----------------------------------------------------
    const team = await j(await fetch(`${BASE}/users/executives`, { headers: auth }));
    check('Team list returns the created executive', team.data.length === 1 && team.data[0].email === 'raj@acme-agency.com', team.data);
    check('Team list reports workload stats', team.data[0].callsLogged === 0 && team.data[0].openLeads === 0, team.data[0]);
    check('Team list shows no assigned campaigns yet', team.data[0].assignedCampaigns.length === 0, team.data[0]);

    // ---- Assignment notification ------------------------------------------
    const csv = 'first_name,last_name,email,phone,company,job_title,industry,source\nA,B,a@x.com,1,C,VP,Tech,Web\n';
    const form = new FormData();
    form.append('clientId', clientId);
    form.append('leadListName', 'List');
    form.append('file', new Blob([csv], { type: 'text/csv' }), 'p.csv');
    const imp = await j(await fetch(`${BASE}/leads/import`, { method: 'POST', headers: auth, body: form }));
    let impStatus;
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 250));
      impStatus = await j(await fetch(`${BASE}/leads/imports/${imp.data.id}/status`, { headers: auth }));
      if (['completed', 'completed_with_errors', 'failed'].includes(impStatus.data.status)) break;
    }
    const leadListId = impStatus.data.leadListId;

    const camp = await j(await fetch(`${BASE}/campaigns`, {
      method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientId, leadListId, name: 'Call Push', type: 'call' })
    }));
    await fetch(`${BASE}/campaigns/${camp.data.id}/executives`, {
      method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ executiveUserIds: [exec.data.id] })
    });
    await new Promise((r) => setTimeout(r, 400));
    check('An assigned executive is notified', sentTo('raj@acme-agency.com', "You've been assigned"), emailLog().slice(-500));

    const teamAfter = await j(await fetch(`${BASE}/users/executives`, { headers: auth }));
    check('Team list now shows the assigned campaign', teamAfter.data[0].assignedCampaigns.length === 1, teamAfter.data[0]);

    // ---- Manager-triggered password reset ---------------------------------
    const resetRes = await fetch(`${BASE}/users/${exec.data.id}/reset-password`, { method: 'POST', headers: auth });
    check('Manager can trigger a password reset for an executive', resetRes.status === 200, await resetRes.json());
    await new Promise((r) => setTimeout(r, 400));
    check('The reset email contains a single-use link (manager never learns the password)', /reset-password\?token=[a-f0-9]+/.test(emailLog()), emailLog().slice(-300));

    // ---- Deactivation revokes access IMMEDIATELY ---------------------------
    const meBefore = await fetch(`${BASE}/auth/me`, { headers: execAuth });
    check('The executive token works before deactivation', meBefore.status === 200);

    const deact = await fetch(`${BASE}/users/${exec.data.id}/deactivate`, { method: 'PATCH', headers: auth });
    const deactBody = await deact.json();
    check('Manager can deactivate an executive', deact.status === 200 && deactBody.data.isActive === false, deactBody);

    // Access is denied immediately, not when the 15-minute token expires.
    // 403 (not 401) because the middleware reports the deactivation itself,
    // which is the more useful message; tokenVersion is the backstop that
    // would catch it anyway.
    const meAfter = await fetch(`${BASE}/auth/me`, { headers: execAuth });
    check('The existing access token is revoked immediately (not on expiry)', meAfter.status === 403, meAfter.status);

    // Prove the tokenVersion bump independently: reactivate (so isActive is
    // no longer the blocker) and confirm the OLD token is still rejected.
    await fetch(`${BASE}/users/${exec.data.id}/reactivate`, { method: 'PATCH', headers: auth });
    const meAfterReactivate = await fetch(`${BASE}/auth/me`, { headers: execAuth });
    check('The pre-deactivation token stays invalid even after reactivation (tokenVersion bumped)', meAfterReactivate.status === 401, meAfterReactivate.status);
    await fetch(`${BASE}/users/${exec.data.id}/deactivate`, { method: 'PATCH', headers: auth });

    const reLogin = await fetch(`${BASE}/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'raj@acme-agency.com', password: tempPassword })
    });
    check('A deactivated executive cannot log back in (403)', reLogin.status === 403, await reLogin.json());

    const resetDeactivated = await fetch(`${BASE}/users/${exec.data.id}/reset-password`, { method: 'POST', headers: auth });
    check('Password reset is refused for a deactivated account (422)', resetDeactivated.status === 422);

    // ---- Reactivation -----------------------------------------------------
    const react = await fetch(`${BASE}/users/${exec.data.id}/reactivate`, { method: 'PATCH', headers: auth });
    check('Manager can reactivate an executive', react.status === 200 && (await react.json()).data.isActive === true);
    const reLogin2 = await fetch(`${BASE}/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'raj@acme-agency.com', password: tempPassword })
    });
    check('A reactivated executive can log in again', reLogin2.status === 200);

    // ---- Cross-tenant isolation -------------------------------------------
    await fetch(`${BASE}/auth/register`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ firstName: 'Bob', lastName: 'X', email: 'bob@rival.com', password: 'Str0ng!Pass2', confirmPassword: 'Str0ng!Pass2' })
    });
    const bob = await j(await fetch(`${BASE}/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'bob@rival.com', password: 'Str0ng!Pass2' })
    }));
    const bobAuth = { Authorization: `Bearer ${bob.data.accessToken}` };

    const bobTeam = await j(await fetch(`${BASE}/users/executives`, { headers: bobAuth }));
    check("Another manager sees none of this manager's executives", bobTeam.data.length === 0, bobTeam.data);

    const bobDeact = await fetch(`${BASE}/users/${exec.data.id}/deactivate`, { method: 'PATCH', headers: bobAuth });
    check("Another manager cannot deactivate this manager's executive (404)", bobDeact.status === 404);

    // ---- A manager cannot be managed through this API ----------------------
    const managerUser = await dm.User.findOne({ where: { email: 'asha@acme-agency.com' } });
    const selfDeact = await fetch(`${BASE}/users/${managerUser.id}/deactivate`, { method: 'PATCH', headers: auth });
    check('A manager account cannot be deactivated via user management (404)', selfDeact.status === 404);

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
