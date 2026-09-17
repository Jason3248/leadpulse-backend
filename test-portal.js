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

async function waitImport(id, headers) {
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 250));
    const s = await j(await fetch(`${BASE}/leads/imports/${id}/status`, { headers }));
    if (['completed', 'completed_with_errors', 'failed'].includes(s.data.status)) return s.data;
  }
  return null;
}

async function main() {
  const api = spawnService('leadpulse-api', '/tmp/portal_api.log');
  const upload = spawnService('leadpulse-upload-service', '/tmp/portal_up.log');
  const emailSvc = spawnService('leadpulse-email-service', '/tmp/portal_em.log');
  await new Promise((r) => setTimeout(r, 2500));

  try {
    const dm = require('leadpulse-data-model');

    // ---- Manager + client + leads --------------------------------------
    await fetch(`${BASE}/auth/register`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ firstName: 'Asha', lastName: 'Rao', email: 'asha@acme-agency.com', password: 'Str0ng!Pass', confirmPassword: 'Str0ng!Pass' })
    });
    const login = await j(await fetch(`${BASE}/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'asha@acme-agency.com', password: 'Str0ng!Pass' })
    }));
    const mgr = { Authorization: `Bearer ${login.data.accessToken}` };
    const managerUser = await dm.User.findOne({ where: { email: 'asha@acme-agency.com' } });

    const clientA = await j(await fetch(`${BASE}/clients`, {
      method: 'POST', headers: { ...mgr, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Acme Corp' })
    }));
    const clientAId = clientA.data.id;

    const csv = 'first_name,last_name,email,phone,company,job_title,industry,source\n' +
      'Ann,A,ann@x.com,111,AlphaCo,VP,Tech,Web\nBen,B,ben@x.com,222,BetaCo,VP,Tech,Web\n' +
      'Cat,C,cat@x.com,333,GammaCo,VP,Tech,Web\nDan,D,dan@x.com,444,DeltaCo,VP,Tech,Web\n';
    const form = new FormData();
    form.append('clientId', clientAId);
    form.append('leadListName', 'Prospects');
    form.append('file', new Blob([csv], { type: 'text/csv' }), 'p.csv');
    const imp = await j(await fetch(`${BASE}/leads/import`, { method: 'POST', headers: mgr, body: form }));
    const impDone = await waitImport(imp.data.id, mgr);
    const leadListId = impDone.leadListId;

    // ---- A call campaign, worked to produce mixed statuses -------------
    const execPass = await require('./leadpulse-api/app/utils/password.util.js').hashPassword('Str0ng!Exec1');
    const exec = await dm.User.create({ role: 'executive', managerId: managerUser.id, firstName: 'Raj', lastName: 'K', email: 'raj@acme-agency.com', passwordHash: execPass });
    const execLogin = await j(await fetch(`${BASE}/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'raj@acme-agency.com', password: 'Str0ng!Exec1' })
    }));
    const execAuth = { Authorization: `Bearer ${execLogin.data.accessToken}` };

    const camp = await j(await fetch(`${BASE}/campaigns`, {
      method: 'POST', headers: { ...mgr, 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientId: clientAId, leadListId, name: 'Q3 Calls', type: 'call', pricingModel: 'cost_per_lead', ratePerLead: 8 })
    }));
    const campaignId = camp.data.id;
    await fetch(`${BASE}/campaigns/${campaignId}/executives`, {
      method: 'POST', headers: { ...mgr, 'Content-Type': 'application/json' },
      body: JSON.stringify({ executiveUserIds: [exec.id] })
    });
    await fetch(`${BASE}/campaigns/${campaignId}/approve`, { method: 'PATCH', headers: mgr });

    // Work the queue: qualify Ann, convert Ben (+confirm), leave others.
    const leads = (await j(await fetch(`${BASE}/leads?clientId=${clientAId}`, { headers: mgr }))).data;
    const annId = leads.find((l) => l.email === 'ann@x.com').id;
    const benId = leads.find((l) => l.email === 'ben@x.com').id;

    // Manual qualify Ann
    await fetch(`${BASE}/leads/${annId}/status`, {
      method: 'PATCH', headers: { ...mgr, 'Content-Type': 'application/json' },
      body: JSON.stringify({ leadListId, status: 'Qualified' })
    });
    // Convert Ben via a call remark, then confirm it
    const benCl = await dm.CampaignLead.findOne({ where: { campaignId, leadId: benId } });
    const conv = await j(await fetch(`${BASE}/call/leads/${benCl.id}/remarks`, {
      method: 'POST', headers: { ...execAuth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ callOutcome: 'Converted', notes: 'INTERNAL: signed on the call', callDurationMinutes: 10 })
    }));
    await fetch(`${BASE}/call/remarks/${conv.data.id}/review`, {
      method: 'PATCH', headers: { ...mgr, 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirmed: true })
    });

    // ---- Create the client portal user --------------------------------
    const portalUser = await j(await fetch(`${BASE}/users/client-users`, {
      method: 'POST', headers: { ...mgr, 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientId: clientAId, firstName: 'Mark', lastName: 'Client', email: 'mark@acme.com', temporaryPassword: 'Cl!entPass9' })
    }));
    const clientLogin = await j(await fetch(`${BASE}/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'mark@acme.com', password: 'Cl!entPass9' })
    }));
    const clientAuth = { Authorization: `Bearer ${clientLogin.data.accessToken}` };

    // ---- Dashboard -----------------------------------------------------
    const dashRes = await fetch(`${BASE}/portal/dashboard`, { headers: clientAuth });
    const dash = await dashRes.json();
    check('Client can load their dashboard', dashRes.status === 200, dash);
    check('Dashboard names the correct client', dash.data.client.name === 'Acme Corp', dash.data.client);
    check('Dashboard shows FULL audience count (proof of effort, all 4 leads)', dash.data.totals.leadsTargeted === 4, dash.data.totals);
    check('Dashboard reports 1 qualified lead', dash.data.totals.qualifiedLeads === 1, dash.data.totals);
    check('Dashboard reports 1 converted lead', dash.data.totals.convertedLeads === 1, dash.data.totals);
    check('Dashboard reports calls logged', dash.data.totals.callsLogged >= 1, dash.data.totals);
    check('Dashboard counts campaigns', dash.data.totals.campaigns === 1 && dash.data.totals.callCampaigns === 1, dash.data.totals);

    // ---- Campaign list -------------------------------------------------
    const listRes = await fetch(`${BASE}/portal/campaigns`, { headers: clientAuth });
    const list = await listRes.json();
    check('Client can list their campaigns', listRes.status === 200 && list.data.length === 1, list.data);
    check('Campaign list shows status and audience count, no lead identities', list.data[0].audienceCount === 4 && !JSON.stringify(list.data[0]).includes('ann@x.com'), list.data[0]);

    // ---- Campaign detail (via report component, role-aware) -----------
    const detailRes = await fetch(`${BASE}/reports/campaigns/${campaignId}`, { headers: clientAuth });
    const detail = await detailRes.json();
    check('Client can open campaign detail', detailRes.status === 200, detail);

    // ---- The redaction consistency check (the important one) ----------
    // Dashboard says 1 qualified + 1 converted = 2 leads whose identities
    // the client may see. The downloadable report must expose exactly those
    // two and withhold the other two.
    const excelRes = await fetch(`${BASE}/reports/campaigns/${campaignId}/excel`, { headers: clientAuth });
    const excelBuf = Buffer.from(await excelRes.arrayBuffer());
    check('Client can download the Excel report', excelRes.status === 200 && excelBuf.slice(0, 2).toString() === 'PK', excelRes.status);

    const ExcelJS = require('exceljs');
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(excelBuf);
    // A call report identifies leads by name/company (no email column). The
    // qualified/converted leads (Ann@AlphaCo, Ben@BetaCo) must be visible;
    // the unqualified ones (Cat@GammaCo, Dan@DeltaCo) must be withheld.
    let visibleCompanies = 0;
    let withheldCompanies = 0;
    let leakedNotes = false;
    wb.eachSheet((sheet) => {
      sheet.eachRow((row) => {
        const text = row.values.map((v) => (v == null ? '' : String(v))).join(' ');
        if (/AlphaCo|BetaCo/.test(text)) visibleCompanies += 1;
        if (/GammaCo|DeltaCo/.test(text)) withheldCompanies += 1;
        if (/INTERNAL: signed on the call/.test(text)) leakedNotes = true;
      });
    });
    check('Client report reveals identities ONLY for Qualified/Converted leads (Ann + Ben)', visibleCompanies === 2, { visibleCompanies });
    check('Client report withholds the unqualified leads (Cat + Dan companies absent)', withheldCompanies === 0, { withheldCompanies });
    check('Internal call notes are NEVER exposed to the client', !leakedNotes, { leakedNotes });

    // Cross-check: the manager's own export shows all four + the notes.
    const mgrExcel = Buffer.from(await (await fetch(`${BASE}/reports/campaigns/${campaignId}/excel`, { headers: mgr })).arrayBuffer());
    const wb2 = new ExcelJS.Workbook();
    await wb2.xlsx.load(mgrExcel);
    let mgrSeesNotes = false;
    let mgrCompanies = 0;
    wb2.eachSheet((sheet) => {
      sheet.eachRow((row) => {
        const text = row.values.map((v) => (v == null ? '' : String(v))).join(' ');
        if (/INTERNAL: signed on the call/.test(text)) mgrSeesNotes = true;
        if (/AlphaCo|BetaCo|GammaCo|DeltaCo/.test(text)) mgrCompanies += 1;
      });
    });
    check('The MANAGER export includes internal notes and ALL four leads (no redaction)', mgrSeesNotes && mgrCompanies === 4, { mgrSeesNotes, mgrCompanies });

    // ---- Cross-client isolation ----------------------------------------
    const clientB = await j(await fetch(`${BASE}/clients`, {
      method: 'POST', headers: { ...mgr, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Globex' })
    }));
    const bCsv = 'first_name,last_name,email,phone,company,job_title,industry,source\nZoe,Z,zoe@y.com,9,ZCo,VP,Tech,Web\n';
    const bForm = new FormData();
    bForm.append('clientId', clientB.data.id);
    bForm.append('leadListName', 'B List');
    bForm.append('file', new Blob([bCsv], { type: 'text/csv' }), 'b.csv');
    const bImp = await j(await fetch(`${BASE}/leads/import`, { method: 'POST', headers: mgr, body: bForm }));
    const bDone = await waitImport(bImp.data.id, mgr);
    const bCamp = await j(await fetch(`${BASE}/campaigns`, {
      method: 'POST', headers: { ...mgr, 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientId: clientB.data.id, leadListId: bDone.leadListId, name: 'B Campaign', type: 'call' })
    }));

    // Mark's dashboard must not include Globex's campaign/leads.
    const dashAgain = await j(await fetch(`${BASE}/portal/dashboard`, { headers: clientAuth }));
    check("Client's dashboard excludes another client's data (still 1 campaign, 4 leads)", dashAgain.data.totals.campaigns === 1 && dashAgain.data.totals.leadsTargeted === 4, dashAgain.data.totals);

    const bDetail = await fetch(`${BASE}/reports/campaigns/${bCamp.data.id}`, { headers: clientAuth });
    check("Client gets 404 on another client's campaign detail", bDetail.status === 404);
    const bExcel = await fetch(`${BASE}/reports/campaigns/${bCamp.data.id}/excel`, { headers: clientAuth });
    check("Client gets 404 downloading another client's report", bExcel.status === 404);

    // ---- Role enforcement ----------------------------------------------
    const mgrOnPortal = await fetch(`${BASE}/portal/dashboard`, { headers: mgr });
    check('A manager cannot use the client-only portal routes (403)', mgrOnPortal.status === 403);
    const execOnPortal = await fetch(`${BASE}/portal/campaigns`, { headers: execAuth });
    check('An executive cannot use the client-only portal routes (403)', execOnPortal.status === 403);

    // A client cannot reach manager-only routes.
    const clientOnMgr = await fetch(`${BASE}/campaigns`, { headers: clientAuth });
    check('A client cannot list all campaigns via the manager route (403)', clientOnMgr.status === 403);
    const clientImport = await fetch(`${BASE}/leads?clientId=${clientAId}`, { headers: clientAuth });
    check('A client cannot reach the raw lead list (403)', clientImport.status === 403);

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
