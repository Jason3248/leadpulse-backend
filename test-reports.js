'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const ExcelJS = require('exceljs');

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
const decodeEntities = (v) => v.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");

async function waitJob(url, headers) {
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 250));
    const res = await j(await fetch(url, { headers }));
    if (['completed', 'completed_with_errors', 'failed'].includes(res.data.status)) return res.data;
  }
  return null;
}

async function main() {
  const api = spawnService('leadpulse-api', '/tmp/rep_api.log');
  const upload = spawnService('leadpulse-upload-service', '/tmp/rep_up.log');
  const emailSvc = spawnService('leadpulse-email-service', '/tmp/rep_em.log');
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
    const mgrAuth = { Authorization: `Bearer ${login.data.accessToken}` };
    const managerUser = await dm.User.findOne({ where: { email: 'asha@acme-agency.com' } });

    const client = await j(await fetch(`${BASE}/clients`, {
      method: 'POST', headers: { ...mgrAuth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Acme Corp' })
    }));
    const clientId = client.data.id;

    const csv = 'first_name,last_name,email,phone,company,job_title,industry,source\n' +
      'Ann,A,ann@x.com,111,AlphaCo,VP,Tech,Web\nBen,B,ben@x.com,222,BetaCo,VP,Tech,Web\n' +
      'Cat,C,cat@x.com,333,GammaCo,VP,Tech,Web\nDan,D,dan@x.com,444,DeltaCo,VP,Tech,Web\n';
    const form = new FormData();
    form.append('clientId', clientId);
    form.append('leadListName', 'Prospects');
    form.append('file', new Blob([csv], { type: 'text/csv' }), 'p.csv');
    const imp = await j(await fetch(`${BASE}/leads/import`, { method: 'POST', headers: mgrAuth, body: form }));
    const impDone = await waitJob(`${BASE}/leads/imports/${imp.data.id}/status`, mgrAuth);
    const leadListId = impDone.leadListId;
    check('Setup: 4 leads imported', impDone.successfulRows === 4, impDone);

    // ---- A CALL campaign with real activity -------------------------------
    const execRes = await j(await fetch(`${BASE}/users/executives`, {
      method: 'POST', headers: { ...mgrAuth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ firstName: 'Raj', lastName: 'Kumar', email: 'raj@acme-agency.com' })
    }));
    const emLog = fs.readFileSync('/tmp/rep_em.log', 'utf8');
    const rajLine = emLog.split('\n').find((l) => l.includes('raj@acme-agency.com') && l.includes('Temporary password'));
    const rajPass = decodeEntities(rajLine.match(/Temporary password:<\/strong>\s*([^<\s]+)/)[1]);
    const rajLogin = await j(await fetch(`${BASE}/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'raj@acme-agency.com', password: rajPass })
    }));
    const execAuth = { Authorization: `Bearer ${rajLogin.data.accessToken}` };

    const callCamp = await j(await fetch(`${BASE}/campaigns`, {
      method: 'POST', headers: { ...mgrAuth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientId, leadListId, name: 'Q3 Outreach', type: 'call', pricingModel: 'cost_per_lead', ratePerLead: 25 })
    }));
    const callCampId = callCamp.data.id;
    await fetch(`${BASE}/campaigns/${callCampId}/executives`, {
      method: 'POST', headers: { ...mgrAuth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ executiveUserIds: [execRes.data.id] })
    });
    await fetch(`${BASE}/campaigns/${callCampId}/approve`, { method: 'PATCH', headers: mgrAuth });

    // Work three leads: one answered+converted, one not interested, one unanswered.
    const c1 = await j(await fetch(`${BASE}/call/campaigns/${callCampId}/next`, { headers: execAuth }));
    const convRemark = await j(await fetch(`${BASE}/call/leads/${c1.data.campaignLeadId}/remarks`, {
      method: 'POST', headers: { ...execAuth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ callOutcome: 'Converted', callDurationMinutes: 14, notes: 'Very interested, signed up' })
    }));
    const c2 = await j(await fetch(`${BASE}/call/campaigns/${callCampId}/next`, { headers: execAuth }));
    await fetch(`${BASE}/call/leads/${c2.data.campaignLeadId}/remarks`, {
      method: 'POST', headers: { ...execAuth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ callOutcome: 'Not Interested', callDurationMinutes: 2, notes: 'Not a fit' })
    });
    const c3 = await j(await fetch(`${BASE}/call/campaigns/${callCampId}/next`, { headers: execAuth }));
    await fetch(`${BASE}/call/leads/${c3.data.campaignLeadId}/remarks`, {
      method: 'POST', headers: { ...execAuth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ callOutcome: 'Answered', callDurationMinutes: 6, notes: 'Follow up later', leadStatusUpdate: 'Qualified' })
    });

    // ---- Report data BEFORE the conversion is confirmed --------------------
    const before = await j(await fetch(`${BASE}/reports/campaigns/${callCampId}`, { headers: mgrAuth }));
    check('Report data endpoint returns a summary', before.data.summary.name === 'Q3 Outreach', before.data.summary);
    check('Calls logged are counted', before.data.metrics.totalCalls === 3, before.data.metrics);
    check('An UNCONFIRMED conversion is not counted as converted', before.data.metrics.funnel.converted === 0, before.data.metrics.funnel);
    check('Unconfirmed conversions accrue NO billing', before.data.billing.amountAccrued === 0, before.data.billing);
    check('Observations flag conversions awaiting review', before.data.observations.some((o) => /awaiting manager review/i.test(o)), before.data.observations);

    // Confirm it.
    await fetch(`${BASE}/call/remarks/${convRemark.data.id}/review`, {
      method: 'PATCH', headers: { ...mgrAuth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirmed: true })
    });

    const after = await j(await fetch(`${BASE}/reports/campaigns/${callCampId}`, { headers: mgrAuth }));
    check('A confirmed conversion IS counted', after.data.metrics.funnel.converted === 1, after.data.metrics.funnel);
    check('Billing accrues only after confirmation (1 x $25)', after.data.billing.amountAccrued === 25, after.data.billing);
    check('Outcome distribution is broken down', after.data.metrics.outcomes.Converted === 1 && after.data.metrics.outcomes['Not Interested'] === 1, after.data.metrics.outcomes);
    check('Average call duration is computed', after.data.metrics.averageDurationMinutes > 0, after.data.metrics);
    check('Per-executive performance is reported', after.data.metrics.executives.length === 1 && after.data.metrics.executives[0].callsLogged === 3, after.data.metrics.executives);

    // ---- PDF: validate real bytes -----------------------------------------
    const pdfRes = await fetch(`${BASE}/reports/campaigns/${callCampId}/pdf`, { headers: mgrAuth });
    const pdfBuf = Buffer.from(await pdfRes.arrayBuffer());
    check('PDF endpoint returns 200', pdfRes.status === 200);
    check('PDF has the correct content type', pdfRes.headers.get('content-type') === 'application/pdf', pdfRes.headers.get('content-type'));
    check('Response is a genuinely valid PDF (%PDF- magic bytes)', pdfBuf.slice(0, 5).toString() === '%PDF-', pdfBuf.slice(0, 10).toString());
    check('PDF is substantive, not an empty shell', pdfBuf.length > 1500, { bytes: pdfBuf.length });
    const disposition = pdfRes.headers.get('content-disposition');
    check('PDF filename follows the SRS pattern', /attachment; filename="Q3_Outreach_Report_\d{8}\.pdf"/.test(disposition), disposition);

    // ---- Excel: open the workbook and read it back ------------------------
    const xlsxRes = await fetch(`${BASE}/reports/campaigns/${callCampId}/excel`, { headers: mgrAuth });
    const xlsxBuf = Buffer.from(await xlsxRes.arrayBuffer());
    check('Excel endpoint returns 200', xlsxRes.status === 200);
    check('Response is a genuinely valid XLSX (PK zip magic bytes)', xlsxBuf.slice(0, 2).toString() === 'PK', xlsxBuf.slice(0, 4));
    check('Excel filename follows the SRS pattern', /attachment; filename="Q3_Outreach_Leads_\d{8}\.xlsx"/.test(xlsxRes.headers.get('content-disposition')), xlsxRes.headers.get('content-disposition'));

    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(xlsxBuf);
    check('Workbook has both required sheets', wb.worksheets.length === 2, wb.worksheets.map((w) => w.name));
    const detail = wb.getWorksheet('Call Remarks');
    const overview = wb.getWorksheet('Campaign Summary');
    check('Sheet 1 is the call remarks sheet', Boolean(detail), wb.worksheets.map((w) => w.name));
    check('Sheet 2 is the campaign summary', Boolean(overview));
    check('Remarks sheet contains a row per logged call (3 + untouched leads)', detail.rowCount >= 4, { rows: detail.rowCount });

    const headerRow = detail.getRow(1).values.filter(Boolean).map(String);
    check('Remarks sheet has the SRS columns', headerRow.includes('Call Outcome') && headerRow.includes('Executive') && headerRow.includes('Notes'), headerRow);

    // The manager's export must contain real notes, not redacted ones.
    const allText = JSON.stringify(detail.getSheetValues());
    check("Manager's export contains the real call notes", allText.includes('Very interested'), allText.slice(0, 200));
    check("Manager's export contains real contact details", allText.includes('ann@x.com') || allText.includes('111'), true);

    // ---- Role access ------------------------------------------------------
    const execReport = await fetch(`${BASE}/reports/campaigns/${callCampId}`, { headers: execAuth });
    check('An assigned executive can read the report', execReport.status === 200);

    await fetch(`${BASE}/auth/register`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ firstName: 'Bob', lastName: 'X', email: 'bob@rival.com', password: 'Str0ng!Pass2', confirmPassword: 'Str0ng!Pass2' })
    });
    const bob = await j(await fetch(`${BASE}/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'bob@rival.com', password: 'Str0ng!Pass2' })
    }));
    const crossPdf = await fetch(`${BASE}/reports/campaigns/${callCampId}/pdf`, { headers: { Authorization: `Bearer ${bob.data.accessToken}` } });
    check("Another manager gets 404 on this campaign's PDF", crossPdf.status === 404);

    // ---- CLIENT redaction — the core business rule -------------------------
    const portalUser = await j(await fetch(`${BASE}/users/client-users`, {
      method: 'POST', headers: { ...mgrAuth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientId, firstName: 'Mark', lastName: 'Client', email: 'mark@acme.com' })
    }));
    const emLog2 = fs.readFileSync('/tmp/rep_em.log', 'utf8');
    const markLine = emLog2.split('\n').find((l) => l.includes('mark@acme.com') && l.includes('Temporary password'));
    const markPass = decodeEntities(markLine.match(/Temporary password:<\/strong>\s*([^<\s]+)/)[1]);
    const markLogin = await j(await fetch(`${BASE}/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'mark@acme.com', password: markPass })
    }));
    const clientAuth = { Authorization: `Bearer ${markLogin.data.accessToken}` };

    const clientReport = await fetch(`${BASE}/reports/campaigns/${callCampId}`, { headers: clientAuth });
    check('The client can read their own campaign report', clientReport.status === 200);
    const clientData = await clientReport.json();
    check('The client sees FULL aggregate counts (proof of effort)', clientData.data.metrics.queue.total === 4 && clientData.data.metrics.totalCalls === 3, clientData.data.metrics);

    const clientXlsx = await fetch(`${BASE}/reports/campaigns/${callCampId}/excel`, { headers: clientAuth });
    const clientBuf = Buffer.from(await clientXlsx.arrayBuffer());
    const cwb = new ExcelJS.Workbook();
    await cwb.xlsx.load(clientBuf);
    const cDetail = cwb.getWorksheet('Call Remarks');
    const cText = JSON.stringify(cDetail.getSheetValues());

    check('The client export still lists every lead (counts reconcile)', cDetail.rowCount === detail.rowCount, { client: cDetail.rowCount, manager: detail.rowCount });
    // c1 (converted) and c3 (qualified) are the two the client MAY see. Assert
    // against their ACTUAL companies rather than hardcoded names — /next order
    // isn't deterministic across runs, which made a fixed-name check flaky.
    const visibleCompanies = [c1.data.company, c3.data.company].filter(Boolean);
    const clientSeesAVisibleCompany = visibleCompanies.some((co) => cText.includes(co));
    check('Converted/Qualified contact details ARE visible to the client', clientSeesAVisibleCompany, { visibleCompanies, sample: cText.slice(0, 200) });
    check('Unqualified leads are withheld from the client', cText.includes('(withheld)'), cText.slice(0, 300));
    check('Internal call notes are never exposed to the client', !cText.includes('Very interested') && cText.includes('(internal)'), cText.slice(0, 300));

    const clientPdf = await fetch(`${BASE}/reports/campaigns/${callCampId}/pdf`, { headers: clientAuth });
    check('The client can download their campaign PDF', clientPdf.status === 200 && Buffer.from(await clientPdf.arrayBuffer()).slice(0, 5).toString() === '%PDF-');

    // A client must not reach another client's campaign.
    const otherClient = await j(await fetch(`${BASE}/clients`, {
      method: 'POST', headers: { ...mgrAuth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Globex' })
    }));
    const otherForm = new FormData();
    otherForm.append('clientId', otherClient.data.id);
    otherForm.append('leadListName', 'Globex Leads');
    otherForm.append('file', new Blob([csv], { type: 'text/csv' }), 'g.csv');
    const otherImp = await j(await fetch(`${BASE}/leads/import`, { method: 'POST', headers: mgrAuth, body: otherForm }));
    const otherDone = await waitJob(`${BASE}/leads/imports/${otherImp.data.id}/status`, mgrAuth);
    const otherCamp = await j(await fetch(`${BASE}/campaigns`, {
      method: 'POST', headers: { ...mgrAuth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientId: otherClient.data.id, leadListId: otherDone.leadListId, name: 'Globex Push', type: 'call' })
    }));
    const crossClient = await fetch(`${BASE}/reports/campaigns/${otherCamp.data.id}`, { headers: clientAuth });
    check("A client gets 404 on a DIFFERENT client's campaign", crossClient.status === 404);

    // ---- EMAIL campaign report --------------------------------------------
    const emailCamp = await j(await fetch(`${BASE}/campaigns`, {
      method: 'POST', headers: { ...mgrAuth, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        clientId, leadListId, name: 'Email Blast', type: 'email', excludeClosedLeads: false,
        subjectLine: 'Hi {{first_name}}', senderName: 'Acme', emailBodyHtml: '<p>Hello {{first_name}}</p>',
        pricingModel: 'flat_retainer', retainerAmount: 500
      })
    }));
    await fetch(`${BASE}/campaigns/${emailCamp.data.id}/approve`, { method: 'PATCH', headers: mgrAuth });
    const disp = await j(await fetch(`${BASE}/email/campaigns/${emailCamp.data.id}/dispatch`, { method: 'POST', headers: mgrAuth }));
    await waitJob(`${BASE}/email/dispatches/${disp.data.id}`, mgrAuth);

    const emailReport = await j(await fetch(`${BASE}/reports/campaigns/${emailCamp.data.id}`, { headers: mgrAuth }));
    check('Email campaign report computes the funnel', emailReport.data.metrics.sent > 0, emailReport.data.metrics);
    check('Email report includes SRS rate metrics', typeof emailReport.data.metrics.rates.openRate === 'number' && typeof emailReport.data.metrics.rates.bounceRate === 'number', emailReport.data.metrics.rates);
    check('Flat retainer billing is reported', emailReport.data.billing.pricingModel === 'flat_retainer' && emailReport.data.billing.retainerAmount === 500, emailReport.data.billing);

    const emailXlsx = await fetch(`${BASE}/reports/campaigns/${emailCamp.data.id}/excel`, { headers: mgrAuth });
    const ewb = new ExcelJS.Workbook();
    await ewb.xlsx.load(Buffer.from(await emailXlsx.arrayBuffer()));
    check('Email export uses the Lead Engagement sheet', Boolean(ewb.getWorksheet('Lead Engagement')), ewb.worksheets.map((w) => w.name));
    const eHeader = ewb.getWorksheet('Lead Engagement').getRow(1).values.filter(Boolean).map(String);
    check('Engagement sheet has the SRS columns', eHeader.includes('Opened At') && eHeader.includes('Clicks') && eHeader.includes('Bounce Type'), eHeader);

    const emailPdf = await fetch(`${BASE}/reports/campaigns/${emailCamp.data.id}/pdf`, { headers: mgrAuth });
    const emailPdfBuf = Buffer.from(await emailPdf.arrayBuffer());
    check('Email campaign PDF generates validly', emailPdfBuf.slice(0, 5).toString() === '%PDF-' && emailPdfBuf.length > 1500, { bytes: emailPdfBuf.length });

    // ---- A campaign with NO activity must not crash -------------------------
    const emptyCamp = await j(await fetch(`${BASE}/campaigns`, {
      method: 'POST', headers: { ...mgrAuth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientId, leadListId, name: 'Untouched', type: 'call' })
    }));
    const emptyReport = await fetch(`${BASE}/reports/campaigns/${emptyCamp.data.id}`, { headers: mgrAuth });
    const emptyBody = await emptyReport.json();
    check('A draft campaign with no audience reports without crashing', emptyReport.status === 200, emptyBody);
    check('An empty campaign produces a sensible observation', emptyBody.data.observations.length > 0, emptyBody.data.observations);
    const emptyPdf = await fetch(`${BASE}/reports/campaigns/${emptyCamp.data.id}/pdf`, { headers: mgrAuth });
    check('An empty campaign still generates a valid PDF', Buffer.from(await emptyPdf.arrayBuffer()).slice(0, 5).toString() === '%PDF-');
    const emptyXlsx = await fetch(`${BASE}/reports/campaigns/${emptyCamp.data.id}/excel`, { headers: mgrAuth });
    check('An empty campaign still generates a valid workbook', Buffer.from(await emptyXlsx.arrayBuffer()).slice(0, 2).toString() === 'PK');

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
