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

async function main() {
  const api = spawnService('leadpulse-api', '/tmp/camp_api.log');
  const upload = spawnService('leadpulse-upload-service', '/tmp/camp_up.log');
  const emailSvc = spawnService('leadpulse-email-service', '/tmp/camp_em.log');
  await new Promise((r) => setTimeout(r, 2500));

  try {
    const dm = require('leadpulse-data-model');

    // --- Manager + client + a lead list with leads ---
    await fetch(`${BASE}/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ firstName: 'Asha', lastName: 'Rao', email: 'asha@acme-agency.com', password: 'Str0ng!Pass', confirmPassword: 'Str0ng!Pass' })
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

    // Import 6 leads so a round-robin split is visible
    const csv = 'first_name,last_name,email,phone,company,job_title,industry,source\n' +
      'L1,A,l1@x.com,1,C1,VP,Manufacturing,Web\n' +
      'L2,B,l2@x.com,2,C2,VP,Manufacturing,Web\n' +
      'L3,C,l3@x.com,3,C3,Director,Manufacturing,Web\n' +
      'L4,D,l4@x.com,4,C4,Director,Retail,Web\n' +
      'L5,E,l5@x.com,5,C5,Manager,Retail,Web\n' +
      'L6,F,l6@x.com,6,C6,Manager,Retail,Web\n';
    const form = new FormData();
    form.append('clientId', clientId);
    form.append('leadListName', 'Prospects');
    form.append('file', new Blob([csv], { type: 'text/csv' }), 'p.csv');
    const startImport = await (await fetch(`${BASE}/leads/import`, { method: 'POST', headers: auth, body: form })).json();
    let importRes = startImport.data;
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline && !['completed', 'completed_with_errors', 'failed'].includes(importRes.status)) {
      await new Promise((r) => setTimeout(r, 250));
      importRes = (await (await fetch(`${BASE}/leads/imports/${startImport.data.id}/status`, { headers: auth })).json()).data;
    }
    const leadListId = importRes.leadListId;
    check('Setup: 6 leads imported', importRes.newToAgency === 6, importRes);

    // Two executives, created directly via the model (no exec API yet)
    const managerUser = await dm.User.findOne({ where: { email: 'asha@acme-agency.com' } });
    const exec1 = await dm.User.create({ role: 'executive', managerId: managerUser.id, firstName: 'Raj', lastName: 'K', email: `raj-${Date.now()}@a.com`, passwordHash: 'x' });
    const exec2 = await dm.User.create({ role: 'executive', managerId: managerUser.id, firstName: 'Priya', lastName: 'S', email: `priya-${Date.now()}@a.com`, passwordHash: 'x' });

    // ============================================================
    // CALL CAMPAIGN
    // ============================================================
    const callCampRes = await fetch(`${BASE}/campaigns`, {
      method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        clientId, leadListId, name: 'Q3 Call Push', type: 'call',
        pricingModel: 'cost_per_lead', ratePerLead: 8
      })
    });
    const callCamp = await callCampRes.json();
    check('Call campaign created as draft', callCampRes.status === 201 && callCamp.data.status === 'draft', callCamp);
    const callCampId = callCamp.data.id;

    // Approving before assigning an executive must fail for a call campaign
    const earlyApprove = await fetch(`${BASE}/campaigns/${callCampId}/approve`, { method: 'PATCH', headers: auth });
    check('Call campaign approval blocked with no executive assigned (422)', earlyApprove.status === 422, await earlyApprove.json());

    // Assign both executives
    const assignRes = await fetch(`${BASE}/campaigns/${callCampId}/executives`, {
      method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ executiveUserIds: [exec1.id, exec2.id] })
    });
    const assign = await assignRes.json();
    check('Both executives assigned', assignRes.status === 200 && assign.data.executives.length === 2, assign);

    // Pricing validation: wrong fields for the model must be rejected
    const badPricing = await fetch(`${BASE}/campaigns`, {
      method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientId, leadListId, name: 'Bad', type: 'call', pricingModel: 'flat_retainer', ratePerLead: 8 })
    });
    check('Pricing mismatch rejected (flat_retainer with ratePerLead)', badPricing.status === 400, await badPricing.json());

    // Approve — this freezes the audience and splits across executives
    const approveRes = await fetch(`${BASE}/campaigns/${callCampId}/approve`, { method: 'PATCH', headers: auth });
    const approved = await approveRes.json();
    check('Call campaign approved -> active', approveRes.status === 200 && approved.data.status === 'active', approved);
    check('Audience frozen: 6 leads', approved.data.audienceCount === 6, approved.data);

    // Verify the round-robin split in the DB: 3 leads each
    const exec1Leads = await dm.CampaignLead.count({ where: { campaignId: callCampId, assignedExecutiveId: exec1.id } });
    const exec2Leads = await dm.CampaignLead.count({ where: { campaignId: callCampId, assignedExecutiveId: exec2.id } });
    check('Leads split evenly across executives (3 + 3)', exec1Leads === 3 && exec2Leads === 3, { exec1Leads, exec2Leads });

    const allPending = await dm.CampaignLead.count({ where: { campaignId: callCampId, queueStatus: 'pending' } });
    check('All frozen call leads start as pending', allPending === 6, { allPending });

    // Re-approving an already-active campaign must fail
    const reApprove = await fetch(`${BASE}/campaigns/${callCampId}/approve`, { method: 'PATCH', headers: auth });
    check('Re-approving an active campaign rejected (422)', reApprove.status === 422);

    // Pause -> resume
    const pauseRes = await fetch(`${BASE}/campaigns/${callCampId}/pause`, { method: 'PATCH', headers: auth });
    check('Campaign paused', (await pauseRes.json()).data.status === 'paused');
    const resumeRes = await fetch(`${BASE}/campaigns/${callCampId}/resume`, { method: 'PATCH', headers: auth });
    check('Campaign resumed to active', (await resumeRes.json()).data.status === 'active');

    // End early -> completed, and stragglers swept to skipped
    const endRes = await fetch(`${BASE}/campaigns/${callCampId}/end`, { method: 'PATCH', headers: auth });
    check('Campaign ended early -> completed', (await endRes.json()).data.status === 'completed');
    const skipped = await dm.CampaignLead.count({ where: { campaignId: callCampId, queueStatus: 'skipped' } });
    check('Ending early swept all open queue rows to skipped', skipped === 6, { skipped });

    // Cannot pause a completed campaign
    const pauseCompleted = await fetch(`${BASE}/campaigns/${callCampId}/pause`, { method: 'PATCH', headers: auth });
    check('Cannot pause a completed campaign (422)', pauseCompleted.status === 422);

    // ============================================================
    // EMAIL CAMPAIGN — no executive required, but needs body fields
    // ============================================================
    const emailCampRes = await fetch(`${BASE}/campaigns`, {
      method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientId, leadListId, name: 'Email Blast', type: 'email' })
    });
    const emailCamp = await emailCampRes.json();
    const emailCampId = emailCamp.data.id;

    // Approve without body fields must fail
    const emailNoBody = await fetch(`${BASE}/campaigns/${emailCampId}/approve`, { method: 'PATCH', headers: auth });
    check('Email campaign approval blocked without subject/sender/body (422)', emailNoBody.status === 422, await emailNoBody.json());

    // Add the fields directly, then approve (no executive needed)
    const emailUpdateRes = await fetch(`${BASE}/campaigns/${emailCampId}`, {
      method: 'PATCH', headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ subjectLine: 'Hello', senderName: 'Acme', emailBodyHtml: '<p>Hi {{first_name}}</p>' })
    });
    check('Email campaign draft updated via the API (no direct DB write needed)', emailUpdateRes.status === 200, await emailUpdateRes.json());
    const emailApprove = await fetch(`${BASE}/campaigns/${emailCampId}/approve`, { method: 'PATCH', headers: auth });
    const emailApproved = await emailApprove.json();
    check('Email campaign approved solo (no executive) -> active', emailApprove.status === 200 && emailApproved.data.status === 'active', emailApproved);
    check('Email audience frozen: 6 leads, no executive/queue', emailApproved.data.audienceCount === 6, emailApproved.data);
    const emailLeadsWithExec = await dm.CampaignLead.count({ where: { campaignId: emailCampId, assignedExecutiveId: { [dm.Sequelize.Op.ne]: null } } });
    check('Email frozen leads have NO executive assigned (email needs no queue)', emailLeadsWithExec === 0, { emailLeadsWithExec });

    // ============================================================
    // SEGMENTATION — a filtered campaign freezes only matching leads
    // ============================================================
    const segCampRes = await fetch(`${BASE}/campaigns`, {
      method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientId, leadListId, name: 'Manufacturing only', type: 'email', segmentationFilters: { industry: 'Manufacturing' } })
    });
    const segCampId = (await segCampRes.json()).data.id;
    await fetch(`${BASE}/campaigns/${segCampId}`, {
      method: 'PATCH', headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ subjectLine: 'H', senderName: 'A', emailBodyHtml: '<p>x</p>' })
    });
    const segApprove = await (await fetch(`${BASE}/campaigns/${segCampId}/approve`, { method: 'PATCH', headers: auth })).json();
    check('Segmented campaign froze only the 3 Manufacturing leads', segApprove.data.audienceCount === 3, segApprove.data);

    // ============================================================
    // Cross-tenant: another manager can't see this campaign
    // ============================================================
    await fetch(`${BASE}/auth/register`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ firstName: 'Bob', lastName: 'X', email: 'bob@rival.com', password: 'Str0ng!Pass2', confirmPassword: 'Str0ng!Pass2' })
    });
    const bobLogin = await (await fetch(`${BASE}/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'bob@rival.com', password: 'Str0ng!Pass2' })
    })).json();
    const crossTenant = await fetch(`${BASE}/campaigns/${callCampId}`, { headers: { Authorization: `Bearer ${bobLogin.data.accessToken}` } });
    check('Another manager gets 404 on this campaign', crossTenant.status === 404);

    // ============================================================
    // LEAD REASSIGNMENT (option 2 — manual control over auto-split)
    // ============================================================
    const reCampRes = await fetch(`${BASE}/campaigns`, {
      method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientId, leadListId, name: 'Reassign Test', type: 'call' })
    });
    const reCampId = (await reCampRes.json()).data.id;
    await fetch(`${BASE}/campaigns/${reCampId}/executives`, {
      method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ executiveUserIds: [exec1.id, exec2.id] })
    });
    await fetch(`${BASE}/campaigns/${reCampId}/approve`, { method: 'PATCH', headers: auth });

    const exec2Rows = await dm.CampaignLead.findAll({ where: { campaignId: reCampId, assignedExecutiveId: exec2.id }, attributes: ['leadId'] });
    const exec2LeadIds = exec2Rows.map((r) => r.leadId);

    const reassignRes = await fetch(`${BASE}/campaigns/${reCampId}/reassign-leads`, {
      method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ targetExecutiveId: exec1.id, leadIds: exec2LeadIds })
    });
    const reassign = await reassignRes.json();
    check("Reassignment moved exec2's leads to exec1", reassignRes.status === 200 && reassign.data.reassigned === exec2LeadIds.length, reassign);

    const exec1NowHas = await dm.CampaignLead.count({ where: { campaignId: reCampId, assignedExecutiveId: exec1.id } });
    const exec2NowHas = await dm.CampaignLead.count({ where: { campaignId: reCampId, assignedExecutiveId: exec2.id } });
    check('After reassignment exec1 has all 6, exec2 has 0', exec1NowHas === 6 && exec2NowHas === 0, { exec1NowHas, exec2NowHas });

    const strangerExec = await dm.User.create({ role: 'executive', managerId: managerUser.id, firstName: 'Stranger', lastName: 'X', email: `stranger-${Date.now()}@a.com`, passwordHash: 'x' });
    const badTarget = await fetch(`${BASE}/campaigns/${reCampId}/reassign-leads`, {
      method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ targetExecutiveId: strangerExec.id, leadIds: [exec2LeadIds[0]] })
    });
    check('Reassigning to a non-assigned executive rejected (400)', badTarget.status === 400, await badTarget.json());

    const oneLead = exec2LeadIds[0];
    await dm.CampaignLead.update({ queueStatus: 'completed' }, { where: { campaignId: reCampId, leadId: oneLead } });
    const workedReassign = await fetch(`${BASE}/campaigns/${reCampId}/reassign-leads`, {
      method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ targetExecutiveId: exec2.id, leadIds: [oneLead] })
    });
    check('A completed (worked) lead cannot be reassigned (422)', workedReassign.status === 422, await workedReassign.json());

    const midExecAssign = await fetch(`${BASE}/campaigns/${reCampId}/executives`, {
      method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ executiveUserIds: [strangerExec.id] })
    });
    check('Executive can be added to a live campaign', midExecAssign.status === 200);
    const stillPending = await dm.CampaignLead.findAll({ where: { campaignId: reCampId, queueStatus: 'pending' }, attributes: ['leadId'], limit: 2 });
    const feedRes = await fetch(`${BASE}/campaigns/${reCampId}/reassign-leads`, {
      method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ targetExecutiveId: strangerExec.id, leadIds: stillPending.map((r) => r.leadId) })
    });
    const feed = await feedRes.json();
    check('Mid-campaign-added executive can be fed pending leads', feedRes.status === 200 && feed.data.reassigned === stillPending.length, feed);

    // ============================================================
    // NEW GUARDS
    // ============================================================
    // Editing is draft-only: an active campaign's audience is frozen.
    const editActive = await fetch(`${BASE}/campaigns/${reCampId}`, {
      method: 'PATCH', headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Should Not Work' })
    });
    check('Editing an ACTIVE campaign rejected (422) — audience already frozen', editActive.status === 422, await editActive.json());

    // A draft CAN be edited.
    const draftForEdit = await (await fetch(`${BASE}/campaigns`, {
      method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientId, leadListId, name: 'Editable Draft', type: 'call' })
    })).json();
    const editDraft = await fetch(`${BASE}/campaigns/${draftForEdit.data.id}`, {
      method: 'PATCH', headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Renamed Draft' })
    });
    const editedDraft = await editDraft.json();
    check('A DRAFT campaign can be edited', editDraft.status === 200 && editedDraft.data.name === 'Renamed Draft', editedDraft);

    // excludeClosedLeads + a Converted membershipStatus filter now conflict
    // loudly instead of the flag being silently ignored.
    const contradiction = await fetch(`${BASE}/campaigns`, {
      method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        clientId, leadListId, name: 'Contradiction', type: 'call',
        segmentationFilters: { membershipStatus: 'Converted' }, excludeClosedLeads: true
      })
    });
    check('Targeting Converted leads while excludeClosedLeads is true is rejected (422)', contradiction.status === 422, await contradiction.json());

    // The same request is accepted once the manager states the intent.
    const reEngage = await fetch(`${BASE}/campaigns`, {
      method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        clientId, leadListId, name: 'Re-engagement', type: 'call',
        segmentationFilters: { membershipStatus: 'Converted' }, excludeClosedLeads: false
      })
    });
    check('A deliberate re-engagement campaign (excludeClosedLeads false) is accepted', reEngage.status === 201);

    // Archived lists can't be used for new campaigns.
    const archivedList = await (await fetch(`${BASE}/lead-lists`, {
      method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientId, name: 'Old Retired List' })
    })).json();
    await fetch(`${BASE}/lead-lists/${archivedList.data.id}/archive`, { method: 'PATCH', headers: auth });
    const archivedCamp = await fetch(`${BASE}/campaigns`, {
      method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientId, leadListId: archivedList.data.id, name: 'On Archived', type: 'call' })
    });
    check('Campaign creation on an ARCHIVED lead list rejected (422)', archivedCamp.status === 422, await archivedCamp.json());

    // Two campaigns can't claim the same sequence step.
    const seq = await dm.Sequence.create({ clientId, name: 'Test Sequence', createdByUserId: managerUser.id });
    await fetch(`${BASE}/campaigns`, {
      method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientId, leadListId, name: 'Step 1', type: 'call', sequenceId: seq.id, sequenceStepOrder: 1 })
    });
    const dupStep = await fetch(`${BASE}/campaigns`, {
      method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientId, leadListId, name: 'Step 1 Again', type: 'call', sequenceId: seq.id, sequenceStepOrder: 1 })
    });
    check('Two campaigns cannot share the same sequence step order (409)', dupStep.status === 409, await dupStep.json());

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
