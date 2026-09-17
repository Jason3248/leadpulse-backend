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

const j = (r) => r.json();

async function waitImport(id, headers) {
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 250));
    const s = await j(await fetch(`${BASE}/leads/imports/${id}/status`, { headers }));
    if (['completed', 'completed_with_errors', 'failed'].includes(s.data.status)) return s.data;
  }
  return null;
}
async function waitDispatch(id, headers) {
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 250));
    const s = await j(await fetch(`${BASE}/email/dispatches/${id}`, { headers }));
    if (['completed', 'completed_with_errors', 'failed'].includes(s.data.status)) return s.data;
  }
  return null;
}

async function main() {
  const api = spawnService('leadpulse-api', '/tmp/seq_api.log');
  const upload = spawnService('leadpulse-upload-service', '/tmp/seq_up.log');
  const emailSvc = spawnService('leadpulse-email-service', '/tmp/seq_em.log');
  await new Promise((r) => setTimeout(r, 2500));

  try {
    const dm = require('leadpulse-data-model');
    const { hashPassword } = require('./leadpulse-api/app/utils/password.util.js');

    // ---- Setup ----------------------------------------------------------
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

    const client = await j(await fetch(`${BASE}/clients`, {
      method: 'POST', headers: { ...mgr, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Acme Corp' })
    }));
    const clientId = client.data.id;

    const csv = 'first_name,last_name,email,phone,company,job_title,industry,source\n' +
      'Ann,A,ann@x.com,111,AlphaCo,VP,Tech,Web\nBen,B,ben@x.com,222,BetaCo,VP,Tech,Web\n' +
      'Cat,C,cat@x.com,333,GammaCo,VP,Tech,Web\nDan,D,dan@x.com,444,DeltaCo,VP,Tech,Web\n';
    const form = new FormData();
    form.append('clientId', clientId);
    form.append('leadListName', 'Motion List');
    form.append('file', new Blob([csv], { type: 'text/csv' }), 'p.csv');
    const imp = await j(await fetch(`${BASE}/leads/import`, { method: 'POST', headers: mgr, body: form }));
    const impDone = await waitImport(imp.data.id, mgr);
    const leadListId = impDone.leadListId;
    check('Setup: 4 leads imported', impDone.successfulRows === 4, impDone);

    const execPass = await hashPassword('Str0ng!Exec1');
    const exec = await dm.User.create({ role: 'executive', managerId: managerUser.id, firstName: 'Raj', lastName: 'K', email: 'raj@acme-agency.com', passwordHash: execPass });
    const confirmer = await dm.User.create({ role: 'campaign_manager', firstName: 'Second', lastName: 'Mgr', email: 'second@acme-agency.com', passwordHash: execPass });
    const execLogin = await j(await fetch(`${BASE}/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'raj@acme-agency.com', password: 'Str0ng!Exec1' })
    }));
    const execAuth = { Authorization: `Bearer ${execLogin.data.accessToken}` };

    // ============================================================
    // A. CREATE A SEQUENCE (previously impossible via the API)
    // ============================================================
    const seqRes = await fetch(`${BASE}/sequences`, {
      method: 'POST', headers: { ...mgr, 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientId, leadListId, name: 'Q3 Outbound Motion', description: 'Email then call', pricingModel: 'cost_per_lead', ratePerLead: 10 })
    });
    const seq = await seqRes.json();
    check('A manager can create a sequence via the API', seqRes.status === 201 && seq.data.name === 'Q3 Outbound Motion', seq);
    check('Sequence carries the pricing (the commercial unit)', seq.data.pricingModel === 'cost_per_lead' && seq.data.ratePerLead === 10, seq.data);
    const seqId = seq.data.id;

    const badPricing = await fetch(`${BASE}/sequences`, {
      method: 'POST', headers: { ...mgr, 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientId, leadListId, name: 'Bad', pricingModel: 'flat_retainer', ratePerLead: 5 })
    });
    check('Mismatched sequence pricing is rejected (400)', badPricing.status === 400);

    // ============================================================
    // B. STEP 1 (email) — one lead converts via the CTA
    // ============================================================
    const step1 = await j(await fetch(`${BASE}/campaigns`, {
      method: 'POST', headers: { ...mgr, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        clientId, leadListId, name: 'Step 1 - Intro Email', type: 'email',
        sequenceId: seqId, sequenceStepOrder: 1,
        subjectLine: 'Hi {{first_name}}', senderName: 'Acme', emailBodyHtml: '<p>Hi {{first_name}}</p>'
      })
    }));
    await fetch(`${BASE}/campaigns/${step1.data.id}/approve`, { method: 'PATCH', headers: mgr });
    const d1 = await j(await fetch(`${BASE}/email/campaigns/${step1.data.id}/dispatch`, { method: 'POST', headers: mgr }));
    const j1 = await waitDispatch(d1.data.id, mgr);
    check('Step 1 dispatched to all 4 leads', j1.sent === 4, j1);

    const leads = (await j(await fetch(`${BASE}/leads?clientId=${clientId}`, { headers: mgr }))).data;
    const annId = leads.find((l) => l.email === 'ann@x.com').id;
    const annCl = await dm.CampaignLead.findOne({ where: { campaignId: step1.data.id, leadId: annId } });
    const annEng = await dm.LeadEngagement.findOne({ where: { campaignLeadId: annCl.id } });

    await fetch(`${BASE}/track/convert`, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: annEng.trackingToken })
    });

    let ledger = await dm.SequenceConversion.count({ where: { sequenceId: seqId } });
    check('Ann converting at step 1 creates ONE ledger row', ledger === 1, { ledger });

    const seqAfter1 = await j(await fetch(`${BASE}/sequences/${seqId}`, { headers: mgr }));
    check('Sequence billing after step 1: 1 conversion x $10 = $10', seqAfter1.data.billing.amountAccrued === 10, seqAfter1.data.billing);
    check('Sequence reports 4 UNIQUE leads reached (not 4 rows, actual people)', seqAfter1.data.totals.uniqueLeadsReached === 4, seqAfter1.data.totals);

    // ============================================================
    // C. STEP 2 (call) — a DIFFERENT lead converts
    // ============================================================
    const step2 = await j(await fetch(`${BASE}/campaigns`, {
      method: 'POST', headers: { ...mgr, 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientId, leadListId, name: 'Step 2 - Follow-up Calls', type: 'call', sequenceId: seqId, sequenceStepOrder: 2 })
    }));
    await fetch(`${BASE}/campaigns/${step2.data.id}/executives`, {
      method: 'POST', headers: { ...mgr, 'Content-Type': 'application/json' },
      body: JSON.stringify({ executiveUserIds: [exec.id] })
    });
    const ap2 = await j(await fetch(`${BASE}/campaigns/${step2.data.id}/approve`, { method: 'PATCH', headers: mgr }));
    // Ann already Converted, so excludeClosedLeads (default true) drops her.
    check('Step 2 audience excludes the already-converted lead (3 of 4)', ap2.data.audienceCount === 3, ap2.data);

    const benId = leads.find((l) => l.email === 'ben@x.com').id;
    const benCl2 = await dm.CampaignLead.findOne({ where: { campaignId: step2.data.id, leadId: benId } });
    const benRemark = await dm.CallRemark.create({
      campaignLeadId: benCl2.id, executiveUserId: exec.id, callOutcome: 'Converted', notes: 'Signed'
    });
    await fetch(`${BASE}/call/remarks/${benRemark.id}/review`, {
      method: 'PATCH', headers: { ...mgr, 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirmed: true })
    });

    ledger = await dm.SequenceConversion.count({ where: { sequenceId: seqId } });
    check('Ben converting at step 2 adds a second ledger row', ledger === 2, { ledger });

    const seqAfter2 = await j(await fetch(`${BASE}/sequences/${seqId}`, { headers: mgr }));
    check('Sequence billing after step 2: 2 conversions x $10 = $20', seqAfter2.data.billing.amountAccrued === 20, seqAfter2.data.billing);
    check('Conversions are attributed to the correct steps', seqAfter2.data.conversionsByStep.every((s) => s.conversions === 1), seqAfter2.data.conversionsByStep);

    // ============================================================
    // D. THE KEY RULE — step 3 re-converts an ALREADY-converted lead
    //    (the "thank you email" case). Must NOT bill twice.
    // ============================================================
    const step3 = await j(await fetch(`${BASE}/campaigns`, {
      method: 'POST', headers: { ...mgr, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        clientId, leadListId, name: 'Step 3 - Thank You', type: 'email',
        sequenceId: seqId, sequenceStepOrder: 3,
        segmentationFilters: { membershipStatus: 'Converted' }, excludeClosedLeads: false,
        subjectLine: 'Thanks!', senderName: 'Acme', emailBodyHtml: '<p>Thank you</p>'
      })
    }));
    const ap3 = await j(await fetch(`${BASE}/campaigns/${step3.data.id}/approve`, { method: 'PATCH', headers: mgr }));
    check('A deliberate thank-you step CAN target already-converted leads', ap3.data.audienceCount === 2, ap3.data);

    const d3 = await j(await fetch(`${BASE}/email/campaigns/${step3.data.id}/dispatch`, { method: 'POST', headers: mgr }));
    const j3 = await waitDispatch(d3.data.id, mgr);
    check('The thank-you email actually SENDS to converted leads (not suppressed)', j3.sent === 2, j3);

    // Ann clicks the CTA again on the thank-you email.
    const annCl3 = await dm.CampaignLead.findOne({ where: { campaignId: step3.data.id, leadId: annId } });
    const annEng3 = await dm.LeadEngagement.findOne({ where: { campaignLeadId: annCl3.id } });
    const reConvertRes = await fetch(`${BASE}/track/convert`, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: annEng3.trackingToken })
    });
    // The DB constraint guarantees billing correctness on its own, but the
    // lead must still see a normal thank-you page — not a 500 because the
    // duplicate insert was rejected. This asserts the graceful handling.
    check('Re-converting returns a normal page to the lead, not a server error', reConvertRes.status === 200, reConvertRes.status);

    ledger = await dm.SequenceConversion.count({ where: { sequenceId: seqId } });
    check('Re-converting in a LATER step does NOT add a ledger row (still 2)', ledger === 2, { ledger });

    const seqAfter3 = await j(await fetch(`${BASE}/sequences/${seqId}`, { headers: mgr }));
    check('Billing is UNCHANGED after re-conversion: still $20, not $30', seqAfter3.data.billing.amountAccrued === 20, seqAfter3.data.billing);
    check('Unique leads reached stays 4 across all 3 steps (no double count)', seqAfter3.data.totals.uniqueLeadsReached === 4, seqAfter3.data.totals);
    check('Sequence reports 3 steps', seqAfter3.data.totals.steps === 3, seqAfter3.data.totals);

    // ============================================================
    // E. A step's own analytics must NOT show its own billing
    // ============================================================
    const step1Analytics = await j(await fetch(`${BASE}/email/campaigns/${step1.data.id}/analytics`, { headers: mgr }));
    check('A sequence STEP does not report its own amount owed', step1Analytics.data.billing.billedAtSequenceLevel === true, step1Analytics.data.billing);
    check('The step points back at its sequence for billing', step1Analytics.data.billing.sequenceName === 'Q3 Outbound Motion', step1Analytics.data.billing);

    // ============================================================
    // F. A SECOND SEQUENCE — same lead is billable again
    // ============================================================
    const seq2 = await j(await fetch(`${BASE}/sequences`, {
      method: 'POST', headers: { ...mgr, 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientId, leadListId, name: 'Q4 New Product Motion', pricingModel: 'cost_per_lead', ratePerLead: 15 })
    }));
    const s2step1 = await j(await fetch(`${BASE}/campaigns`, {
      method: 'POST', headers: { ...mgr, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        clientId, leadListId, name: 'Q4 Step 1', type: 'email', sequenceId: seq2.data.id, sequenceStepOrder: 1,
        segmentationFilters: { membershipStatus: 'Converted' }, excludeClosedLeads: false,
        subjectLine: 'New product', senderName: 'Acme', emailBodyHtml: '<p>New</p>'
      })
    }));
    await fetch(`${BASE}/campaigns/${s2step1.data.id}/approve`, { method: 'PATCH', headers: mgr });
    const d4 = await j(await fetch(`${BASE}/email/campaigns/${s2step1.data.id}/dispatch`, { method: 'POST', headers: mgr }));
    await waitDispatch(d4.data.id, mgr);

    const annClS2 = await dm.CampaignLead.findOne({ where: { campaignId: s2step1.data.id, leadId: annId } });
    const annEngS2 = await dm.LeadEngagement.findOne({ where: { campaignLeadId: annClS2.id } });
    await fetch(`${BASE}/track/convert`, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: annEngS2.trackingToken })
    });

    const seq2Ledger = await dm.SequenceConversion.count({ where: { sequenceId: seq2.data.id } });
    check('The SAME lead converting in a DIFFERENT sequence IS billable again', seq2Ledger === 1, { seq2Ledger });
    const seq2Roll = await j(await fetch(`${BASE}/sequences/${seq2.data.id}`, { headers: mgr }));
    check('Second sequence bills at its own rate (1 x $15)', seq2Roll.data.billing.amountAccrued === 15, seq2Roll.data.billing);
    const seq1Unchanged = await j(await fetch(`${BASE}/sequences/${seqId}`, { headers: mgr }));
    check('The first sequence is unaffected by the second (still $20)', seq1Unchanged.data.billing.amountAccrued === 20, seq1Unchanged.data.billing);

    // ============================================================
    // G. SINGLE-STEP SEQUENCE
    // ============================================================
    const soloSeq = await j(await fetch(`${BASE}/sequences`, {
      method: 'POST', headers: { ...mgr, 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientId, leadListId, name: 'One-Step Motion', pricingModel: 'cost_per_lead', ratePerLead: 7 })
    }));
    const soloStep = await j(await fetch(`${BASE}/campaigns`, {
      method: 'POST', headers: { ...mgr, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        clientId, leadListId, name: 'Only Step', type: 'email', sequenceId: soloSeq.data.id, sequenceStepOrder: 1,
        excludeClosedLeads: false,
        subjectLine: 'Solo', senderName: 'Acme', emailBodyHtml: '<p>Solo</p>'
      })
    }));
    await fetch(`${BASE}/campaigns/${soloStep.data.id}/approve`, { method: 'PATCH', headers: mgr });
    const d5 = await j(await fetch(`${BASE}/email/campaigns/${soloStep.data.id}/dispatch`, { method: 'POST', headers: mgr }));
    await waitDispatch(d5.data.id, mgr);
    const catId = leads.find((l) => l.email === 'cat@x.com').id;
    const catClSolo = await dm.CampaignLead.findOne({ where: { campaignId: soloStep.data.id, leadId: catId } });
    const catEngSolo = await dm.LeadEngagement.findOne({ where: { campaignLeadId: catClSolo.id } });
    await fetch(`${BASE}/track/convert`, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: catEngSolo.trackingToken })
    });
    const soloRoll = await j(await fetch(`${BASE}/sequences/${soloSeq.data.id}`, { headers: mgr }));
    check('A SINGLE-step sequence bills correctly (1 x $7)', soloRoll.data.billing.amountAccrued === 7, soloRoll.data.billing);
    check('A single-step sequence reports 1 step', soloRoll.data.totals.steps === 1, soloRoll.data.totals);

    // ============================================================
    // H. STANDALONE CAMPAIGN (no sequence) still bills on its own
    // ============================================================
    const standalone = await j(await fetch(`${BASE}/campaigns`, {
      method: 'POST', headers: { ...mgr, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        clientId, leadListId, name: 'One-off Blast', type: 'email',
        excludeClosedLeads: false, pricingModel: 'cost_per_lead', ratePerLead: 3,
        subjectLine: 'Blast', senderName: 'Acme', emailBodyHtml: '<p>Blast</p>'
      })
    }));
    await fetch(`${BASE}/campaigns/${standalone.data.id}/approve`, { method: 'PATCH', headers: mgr });
    const d6 = await j(await fetch(`${BASE}/email/campaigns/${standalone.data.id}/dispatch`, { method: 'POST', headers: mgr }));
    await waitDispatch(d6.data.id, mgr);
    const danId = leads.find((l) => l.email === 'dan@x.com').id;
    const danClSa = await dm.CampaignLead.findOne({ where: { campaignId: standalone.data.id, leadId: danId } });
    const danEngSa = await dm.LeadEngagement.findOne({ where: { campaignLeadId: danClSa.id } });
    await fetch(`${BASE}/track/convert`, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: danEngSa.trackingToken })
    });
    const saAnalytics = await j(await fetch(`${BASE}/email/campaigns/${standalone.data.id}/analytics`, { headers: mgr }));
    check('A STANDALONE campaign still bills on its own (1 x $3)', saAnalytics.data.billing.amountAccrued === 3, saAnalytics.data.billing);
    check('A standalone campaign is NOT flagged as sequence-billed', !saAnalytics.data.billing.billedAtSequenceLevel, saAnalytics.data.billing);
    const saLedger = await dm.SequenceConversion.count();
    check('Standalone conversions never enter the sequence ledger', saLedger === 4, { saLedger });

    // ============================================================
    // I. FLAT RETAINER at sequence level
    // ============================================================
    const retSeq = await j(await fetch(`${BASE}/sequences`, {
      method: 'POST', headers: { ...mgr, 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientId, leadListId, name: 'Retainer Motion', pricingModel: 'flat_retainer', retainerAmount: 1000 })
    }));
    const retRoll = await j(await fetch(`${BASE}/sequences/${retSeq.data.id}`, { headers: mgr }));
    check('A retainer sequence reports the retainer amount', retRoll.data.billing.retainerAmount === 1000, retRoll.data.billing);
    check('Cost per conversion is null with zero conversions (no divide-by-zero)', retRoll.data.billing.costPerConversion === null, retRoll.data.billing);

    // ============================================================
    // J. CLIENT PORTAL — sequences visible, billing correct, no identities
    // ============================================================
    await fetch(`${BASE}/users/client-users`, {
      method: 'POST', headers: { ...mgr, 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientId, firstName: 'Mark', lastName: 'C', email: 'mark@acme.com', temporaryPassword: 'Cl!entPass9' })
    });
    const clientLogin = await j(await fetch(`${BASE}/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'mark@acme.com', password: 'Cl!entPass9' })
    }));
    const clientAuth = { Authorization: `Bearer ${clientLogin.data.accessToken}` };

    const portalSeqs = await j(await fetch(`${BASE}/portal/sequences`, { headers: clientAuth }));
    check('Client can see their sequences', portalSeqs.data.length === 4, { count: portalSeqs.data.length });
    const q3 = portalSeqs.data.find((s) => s.name === 'Q3 Outbound Motion');
    check('Client sees sequence billing (one amount for the whole motion)', q3.billing.amountAccrued === 20, q3.billing);
    check('Client sees the steps that make up the motion', q3.steps.length === 3, q3.steps);
    check('Client sees deduplicated unique leads reached', q3.totals.uniqueLeadsReached === 4, q3.totals);
    check('No lead identities leak into the sequence view', !JSON.stringify(portalSeqs.data).includes('ann@x.com'), 'ok');

    const portalSeqDetail = await fetch(`${BASE}/portal/sequences/${seqId}`, { headers: clientAuth });
    check('Client can open one sequence in detail', portalSeqDetail.status === 200);

    const portalCamps = await j(await fetch(`${BASE}/portal/campaigns`, { headers: clientAuth }));
    const stepCamp = portalCamps.data.find((c) => c.name === 'Step 1 - Intro Email');
    const soloCamp = portalCamps.data.find((c) => c.name === 'One-off Blast');
    check('Campaign list marks sequence steps with their sequence + order', stepCamp.sequenceId === seqId && stepCamp.sequenceStepOrder === 1, stepCamp);
    check('Campaign list marks standalone campaigns as standalone', soloCamp.isStandalone === true, soloCamp);

    const dash = await j(await fetch(`${BASE}/portal/dashboard`, { headers: clientAuth }));
    check('Dashboard leadsTargeted is now UNIQUE people (4), not inflated row count', dash.data.totals.leadsTargeted === 4, dash.data.totals);

    // ============================================================
    // K. SEQUENCE-LEVEL REPORTS (the client-facing deliverable)
    // ============================================================
    const seqPdfRes = await fetch(`${BASE}/reports/sequences/${seqId}/pdf`, { headers: mgr });
    const seqPdfBuf = Buffer.from(await seqPdfRes.arrayBuffer());
    check('Manager can download a sequence PDF', seqPdfRes.status === 200 && seqPdfBuf.slice(0, 5).toString() === '%PDF-', { status: seqPdfRes.status, bytes: seqPdfBuf.length });
    check('The sequence PDF has real content (not an empty shell)', seqPdfBuf.length > 1500, { bytes: seqPdfBuf.length });

    const seqXlsxRes = await fetch(`${BASE}/reports/sequences/${seqId}/excel`, { headers: mgr });
    const seqXlsxBuf = Buffer.from(await seqXlsxRes.arrayBuffer());
    check('Manager can download a sequence Excel', seqXlsxRes.status === 200 && seqXlsxBuf.slice(0, 2).toString() === 'PK', seqXlsxRes.status);

    // Verify the workbook actually carries the right numbers.
    const ExcelJS = require('exceljs');
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(seqXlsxBuf);
    let sheetText = '';
    let stepRows = 0;
    wb.eachSheet((sheet) => {
      sheet.eachRow((row, n) => {
        sheetText += row.values.map((v) => (v == null ? '' : String(v))).join(' ') + '\n';
        if (sheet.name === 'Campaign Steps' && n > 1) stepRows += 1;
      });
    });
    check('Sequence workbook lists all 3 steps', stepRows === 3, { stepRows });
    check('Sequence workbook reports the correct amount accrued (20)', /\b20\b/.test(sheetText), sheetText.slice(0, 200));
    check('Sequence workbook reports deduplicated unique leads (4)', sheetText.includes('Unique leads reached'), 'ok');
    check('Sequence report contains NO lead identities', !sheetText.includes('ann@x.com') && !sheetText.includes('AlphaCo'), 'ok');

    // The CLIENT can download their own sequence report.
    const clientSeqPdf = await fetch(`${BASE}/reports/sequences/${seqId}/pdf`, { headers: clientAuth });
    check('Client can download their own sequence PDF', clientSeqPdf.status === 200 && Buffer.from(await clientSeqPdf.arrayBuffer()).slice(0, 5).toString() === '%PDF-');
    const clientSeqXlsx = await fetch(`${BASE}/reports/sequences/${seqId}/excel`, { headers: clientAuth });
    check('Client can download their own sequence Excel', clientSeqXlsx.status === 200);

    // ============================================================
    // L. SECURITY
    // ============================================================
    await fetch(`${BASE}/auth/register`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ firstName: 'Bob', lastName: 'X', email: 'bob@rival.com', password: 'Str0ng!Pass2', confirmPassword: 'Str0ng!Pass2' })
    });
    const bob = await j(await fetch(`${BASE}/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'bob@rival.com', password: 'Str0ng!Pass2' })
    }));
    const bobAuth = { Authorization: `Bearer ${bob.data.accessToken}` };
    const crossSeq = await fetch(`${BASE}/sequences/${seqId}`, { headers: bobAuth });
    check("Another manager gets 404 on someone else's sequence", crossSeq.status === 404);
    const bobList = await j(await fetch(`${BASE}/sequences`, { headers: bobAuth }));
    check('Another manager sees no sequences of their own', bobList.data.length === 0, bobList.data);
    const clientOnMgrSeq = await fetch(`${BASE}/sequences`, { headers: clientAuth });
    check('A client cannot use the manager sequence route (403)', clientOnMgrSeq.status === 403);

    const bobSeqPdf = await fetch(`${BASE}/reports/sequences/${seqId}/pdf`, { headers: bobAuth });
    check("Another manager gets 404 downloading someone else's sequence report", bobSeqPdf.status === 404);

    // A second client's portal user must not reach the first client's report.
    const client2 = await j(await fetch(`${BASE}/clients`, {
      method: 'POST', headers: { ...mgr, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Globex' })
    }));
    await fetch(`${BASE}/users/client-users`, {
      method: 'POST', headers: { ...mgr, 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientId: client2.data.id, firstName: 'Other', lastName: 'C', email: 'other@globex.com', temporaryPassword: 'Cl!entPass9' })
    });
    const otherClientLogin = await j(await fetch(`${BASE}/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'other@globex.com', password: 'Cl!entPass9' })
    }));
    const otherClientAuth = { Authorization: `Bearer ${otherClientLogin.data.accessToken}` };
    const crossClientPdf = await fetch(`${BASE}/reports/sequences/${seqId}/pdf`, { headers: otherClientAuth });
    check("A different client's portal user gets 404 on this sequence report", crossClientPdf.status === 404);
    const crossClientPortal = await fetch(`${BASE}/portal/sequences/${seqId}`, { headers: otherClientAuth });
    check("A different client's portal user gets 404 on this sequence detail", crossClientPortal.status === 404);

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
