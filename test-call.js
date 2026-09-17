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

async function main() {
  const api = spawnService('leadpulse-api', '/tmp/call_api.log');
  const upload = spawnService('leadpulse-upload-service', '/tmp/call_up.log');
  const emailSvc = spawnService('leadpulse-email-service', '/tmp/call_em.log');
  await new Promise((r) => setTimeout(r, 2500));

  try {
    const dm = require('leadpulse-data-model');
    const { hashPassword } = require('./leadpulse-api/app/utils/password.util.js');

    // ---- Manager, client, leads ----------------------------------------
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
      'L1,A,l1@x.com,111,C1,VP,Tech,Web\nL2,B,l2@x.com,222,C2,VP,Tech,Web\n' +
      'L3,C,l3@x.com,333,C3,VP,Tech,Web\nL4,D,l4@x.com,444,C4,VP,Tech,Web\n';
    const form = new FormData();
    form.append('clientId', clientId);
    form.append('leadListName', 'Call Prospects');
    form.append('file', new Blob([csv], { type: 'text/csv' }), 'p.csv');
    const importJob = await j(await fetch(`${BASE}/leads/import`, { method: 'POST', headers: mgrAuth, body: form }));

    let jobStatus;
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 250));
      jobStatus = await j(await fetch(`${BASE}/leads/imports/${importJob.data.id}/status`, { headers: mgrAuth }));
      if (['completed', 'completed_with_errors', 'failed'].includes(jobStatus.data.status)) break;
    }
    check('Setup: 4 leads imported', jobStatus.data.successfulRows === 4, jobStatus.data);
    const leadListId = jobStatus.data.leadListId;

    // ---- Two executives (created directly; no executive API yet) -------
    const execPass = await hashPassword('Str0ng!Exec1');
    const exec1 = await dm.User.create({ role: 'executive', managerId: managerUser.id, firstName: 'Raj', lastName: 'K', email: 'raj@acme-agency.com', passwordHash: execPass });
    const exec2 = await dm.User.create({ role: 'executive', managerId: managerUser.id, firstName: 'Priya', lastName: 'S', email: 'priya@acme-agency.com', passwordHash: execPass });

    const execLogin = async (email) => {
      const r = await j(await fetch(`${BASE}/auth/login`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password: 'Str0ng!Exec1' })
      }));
      return { Authorization: `Bearer ${r.data.accessToken}` };
    };
    const exec1Auth = await execLogin('raj@acme-agency.com');
    const exec2Auth = await execLogin('priya@acme-agency.com');

    // ---- Call campaign, approved -> audience frozen & split -------------
    const camp = await j(await fetch(`${BASE}/campaigns`, {
      method: 'POST', headers: { ...mgrAuth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientId, leadListId, name: 'Q3 Calls', type: 'call', pricingModel: 'cost_per_lead', ratePerLead: 8 })
    }));
    const campaignId = camp.data.id;
    await fetch(`${BASE}/campaigns/${campaignId}/executives`, {
      method: 'POST', headers: { ...mgrAuth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ executiveUserIds: [exec1.id, exec2.id] })
    });
    await fetch(`${BASE}/campaigns/${campaignId}/approve`, { method: 'PATCH', headers: mgrAuth });

    // ---- Executive dashboard ------------------------------------------
    const myCamps = await j(await fetch(`${BASE}/call/my-campaigns`, { headers: exec1Auth }));
    check('Executive sees only their assigned call campaigns', myCamps.data.length === 1 && myCamps.data[0].id === campaignId, myCamps.data);
    check('Executive sees their own pending lead count (2 of 4)', myCamps.data[0].myPendingLeads === 2, myCamps.data[0]);

    const mgrCantUseExecRoute = await fetch(`${BASE}/call/my-campaigns`, { headers: mgrAuth });
    check('Manager is blocked from the executive-only queue route (403)', mgrCantUseExecRoute.status === 403);

    // ---- Serving the queue ---------------------------------------------
    const card1 = await j(await fetch(`${BASE}/call/campaigns/${campaignId}/next`, { headers: exec1Auth }));
    check('Executive is served a Call Card with contact details', Boolean(card1.data && card1.data.phone && card1.data.leadId), card1.data);
    check('A fresh lead has no previous remarks', card1.data.previousRemarks.length === 0);

    const exec2Card = await j(await fetch(`${BASE}/call/campaigns/${campaignId}/next`, { headers: exec2Auth }));
    check("Executives are served from their own slice (different leads)", exec2Card.data.leadId !== card1.data.leadId, { a: card1.data.leadId, b: exec2Card.data.leadId });

    // Cross-executive protection
    const crossLog = await fetch(`${BASE}/call/leads/${exec2Card.data.campaignLeadId}/remarks`, {
      method: 'POST', headers: { ...exec1Auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ callOutcome: 'Answered' })
    });
    check("One executive cannot log against another's assigned lead (404)", crossLog.status === 404);

    // ---- Outcome: Not Answered -> Contacted, stays workable -------------
    const r1 = await j(await fetch(`${BASE}/call/leads/${card1.data.campaignLeadId}/remarks`, {
      method: 'POST', headers: { ...exec1Auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ callOutcome: 'Not Answered', callDurationMinutes: 0 })
    }));
    check('Remark logged for an unanswered call', r1.data.callOutcome === 'Not Answered', r1.data);
    const m1 = await dm.LeadListMembership.findOne({ where: { leadListId, leadId: card1.data.leadId } });
    check('An attempt promotes the lead to Contacted', m1.status === 'Contacted', { status: m1.status });

    // ---- THE ROTATION TEST (reproduces the reported scenario) ----------
    // After marking card1 "Not Answered", the very next /next call must serve
    // exec1's OTHER pending lead — NOT card1 again. A just-attempted lead
    // goes to the BACK of the queue; it must not be handed straight back,
    // which would trap the executive on one unreachable person forever.
    const nextAfterAttempt = await j(await fetch(`${BASE}/call/campaigns/${campaignId}/next`, { headers: exec1Auth }));
    check(
      'After "Not Answered", a DIFFERENT lead is served next (not the same one again)',
      nextAfterAttempt.data && nextAfterAttempt.data.leadId !== card1.data.leadId,
      { served: nextAfterAttempt.data && nextAfterAttempt.data.leadId, previous: card1.data.leadId }
    );
    const rotationCard2 = nextAfterAttempt.data;

    // Now mark THAT lead "Not Answered" too. Both of exec1's leads are now
    // 'called'. The next call should cycle back to the least-recently-worked
    // one — which is card1 (worked first) — proving unreached leads DO come
    // back, just at the back of the line rather than immediately.
    await fetch(`${BASE}/call/leads/${rotationCard2.campaignLeadId}/remarks`, {
      method: 'POST', headers: { ...exec1Auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ callOutcome: 'Not Answered' })
    });
    const cycled = await j(await fetch(`${BASE}/call/campaigns/${campaignId}/next`, { headers: exec1Auth }));
    check(
      'Once the whole slice is worked, the least-recently-attempted lead cycles back',
      cycled.data && cycled.data.leadId === card1.data.leadId,
      { served: cycled.data && cycled.data.leadId, expectedLeastRecent: card1.data.leadId }
    );
    check('The cycled-back lead carries its previous remark history', cycled.data.previousRemarks.length >= 1, cycled.data.previousRemarks);

    // ---- Validation: callback needs a date -----------------------------
    const noDate = await fetch(`${BASE}/call/leads/${card1.data.campaignLeadId}/remarks`, {
      method: 'POST', headers: { ...exec1Auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ callOutcome: 'Callback Requested' })
    });
    check('"Callback Requested" without a follow-up date is rejected (400)', noDate.status === 400);

    const strayDate = await fetch(`${BASE}/call/leads/${card1.data.campaignLeadId}/remarks`, {
      method: 'POST', headers: { ...exec1Auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ callOutcome: 'Answered', followUpDate: '2026-01-01' })
    });
    check('A follow-up date on a non-callback outcome is rejected (400)', strayDate.status === 400);

    // ---- Proof the fix matters: a campaign can genuinely reach exhaustion
    // even when every lead needs multiple "Not Answered"-style attempts —
    // exactly the realistic pattern the original bug made unreachable. -----
    const exhaustCsv = 'first_name,last_name,email,phone,company,job_title,industry,source\n' +
      'E1,X,e1@x.com,1,C,VP,Tech,Web\nE2,X,e2@x.com,2,C,VP,Tech,Web\n';
    const exhaustForm = new FormData();
    exhaustForm.append('clientId', clientId);
    exhaustForm.append('leadListId', leadListId);
    exhaustForm.append('file', new Blob([exhaustCsv], { type: 'text/csv' }), 'e.csv');
    const exhaustJob = await j(await fetch(`${BASE}/leads/import`, { method: 'POST', headers: mgrAuth, body: exhaustForm }));
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 250));
      const s = await j(await fetch(`${BASE}/leads/imports/${exhaustJob.data.id}/status`, { headers: mgrAuth }));
      if (['completed', 'completed_with_errors', 'failed'].includes(s.data.status)) break;
    }

    const exhaustCamp = await j(await fetch(`${BASE}/campaigns`, {
      method: 'POST', headers: { ...mgrAuth, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        clientId, leadListId, name: 'Exhaustion Test', type: 'call',
        segmentationFilters: { source: 'Web' }, excludeClosedLeads: true
      })
    }));
    // Narrow to just these two fresh leads via a direct membership check
    // would be complex; instead assign one executive and work through
    // whatever gets frozen, logging "Not Answered" repeatedly until the
    // queue is provably exhausted.
    await fetch(`${BASE}/campaigns/${exhaustCamp.data.id}/executives`, {
      method: 'POST', headers: { ...mgrAuth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ executiveUserIds: [exec1.id] })
    });
    const exhaustApprove = await j(await fetch(`${BASE}/campaigns/${exhaustCamp.data.id}/approve`, { method: 'PATCH', headers: mgrAuth }));
    const audienceSize = exhaustApprove.data.audienceCount;

    // Resolve every lead with a hard-terminal outcome after at most one
    // "Not Answered" pass each, bounded generously so this can never hang.
    let exhaustedCorrectly = false;
    for (let attempt = 0; attempt < audienceSize * 3 + 5; attempt++) {
      const card = await j(await fetch(`${BASE}/call/campaigns/${exhaustCamp.data.id}/next`, { headers: exec1Auth }));
      if (!card.data) { exhaustedCorrectly = true; break; }
      const seenBefore = card.data.previousRemarks.length > 0;
      await fetch(`${BASE}/call/leads/${card.data.campaignLeadId}/remarks`, {
        method: 'POST', headers: { ...exec1Auth, 'Content-Type': 'application/json' },
        body: JSON.stringify({ callOutcome: seenBefore ? 'Wrong Number' : 'Not Answered' })
      });
    }
    check(
      'Every lead eventually resolves and the queue genuinely empties (queueExhausted reached)',
      exhaustedCorrectly,
      { audienceSize }
    );

    // Exhaustion must auto-complete the campaign and notify the manager.
    const exhaustCampFinal = await j(await fetch(`${BASE}/campaigns/${exhaustCamp.data.id}`, { headers: mgrAuth }));
    check('A fully-worked call campaign auto-completes by exhaustion', exhaustCampFinal.data.status === 'completed', { s: exhaustCampFinal.data.status });
    await new Promise((r) => setTimeout(r, 500));
    const callEmLog = fs.readFileSync('/tmp/call_em.log', 'utf8');
    check('Manager is notified when a call campaign completes', callEmLog.includes('has been completed'), callEmLog.slice(-400));
    const stillOpen = await dm.CampaignLead.count({
      where: { campaignId: exhaustCamp.data.id, queueStatus: { [dm.Sequelize.Op.in]: ['pending', 'in_progress', 'called'] } }
    });
    check('No leads remain in an open state once the queue is exhausted', stillOpen === 0, { stillOpen });


    const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    await fetch(`${BASE}/call/leads/${card1.data.campaignLeadId}/remarks`, {
      method: 'POST', headers: { ...exec1Auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ callOutcome: 'Callback Requested', followUpDate: yesterday, notes: 'Call back Tuesday' })
    });
    const clAfterCallback = await dm.CampaignLead.findByPk(card1.data.campaignLeadId);
    check('A callback leaves the lead in_progress (campaign stays open)', clAfterCallback.queueStatus === 'in_progress', { q: clAfterCallback.queueStatus });

    // A callback keeps the lead in the queue (verified above via
    // in_progress). Under correct rotation it comes back at the BACK of the
    // line, not immediately — card1 was just worked, so a
    // less-recently-touched lead is served first. Confirm card1 is still
    // reachable by cycling through the queue, and that it carries history.
    let foundCard1Again = false;
    let card1History = 0;
    for (let i = 0; i < 6; i++) {
      const c = await j(await fetch(`${BASE}/call/campaigns/${campaignId}/next`, { headers: exec1Auth }));
      if (!c.data) break;
      if (c.data.leadId === card1.data.leadId) {
        foundCard1Again = true;
        card1History = c.data.previousRemarks.length;
        break;
      }
      // Move this other lead along so the loop advances toward card1.
      await fetch(`${BASE}/call/leads/${c.data.campaignLeadId}/remarks`, {
        method: 'POST', headers: { ...exec1Auth, 'Content-Type': 'application/json' },
        body: JSON.stringify({ callOutcome: 'Not Answered' })
      });
    }
    check('A lead with an open callback remains reachable in the queue (comes back around)', foundCard1Again, { foundCard1Again });
    check('The re-served callback lead carries its previous remark history', card1History >= 2, { card1History });

    const dueExec = await j(await fetch(`${BASE}/call/campaigns/${campaignId}/callbacks-due`, { headers: exec1Auth }));
    check('An overdue callback appears in callbacks-due, flagged overdue', dueExec.data.length === 1 && dueExec.data[0].overdue === true, dueExec.data);

    // A later call supersedes the callback -> it must drop off the list
    await fetch(`${BASE}/call/leads/${card1.data.campaignLeadId}/remarks`, {
      method: 'POST', headers: { ...exec1Auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ callOutcome: 'Answered', notes: 'Reached them' })
    });
    const dueAfter = await j(await fetch(`${BASE}/call/campaigns/${campaignId}/callbacks-due`, { headers: exec1Auth }));
    check('A superseded callback no longer shows as due (only latest remark counts)', dueAfter.data.length === 0, dueAfter.data);

    // ---- Not Interested -> Dead, resolves the lead ----------------------
    const card2 = await j(await fetch(`${BASE}/call/campaigns/${campaignId}/next`, { headers: exec1Auth }));
    await fetch(`${BASE}/call/leads/${card2.data.campaignLeadId}/remarks`, {
      method: 'POST', headers: { ...exec1Auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ callOutcome: 'Not Interested' })
    });
    const m2 = await dm.LeadListMembership.findOne({ where: { leadListId, leadId: card2.data.leadId } });
    const cl2 = await dm.CampaignLead.findByPk(card2.data.campaignLeadId);
    check('"Not Interested" marks the lead Dead automatically', m2.status === 'Dead', { status: m2.status });
    check('"Not Interested" completes the queue row', cl2.queueStatus === 'completed', { q: cl2.queueStatus });

    const relog = await fetch(`${BASE}/call/leads/${card2.data.campaignLeadId}/remarks`, {
      method: 'POST', headers: { ...exec1Auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ callOutcome: 'Answered' })
    });
    check('An already-resolved lead cannot receive another remark (422)', relog.status === 422);

    // ---- Converted: claim does NOT convert until reviewed ---------------
    const card3 = await j(await fetch(`${BASE}/call/campaigns/${campaignId}/next`, { headers: exec2Auth }));
    const conv = await j(await fetch(`${BASE}/call/leads/${card3.data.campaignLeadId}/remarks`, {
      method: 'POST', headers: { ...exec2Auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ callOutcome: 'Converted', notes: 'Signed up', callDurationMinutes: 12 })
    }));
    check('A conversion claim is flagged as awaiting review', conv.data.awaitingConversionReview === true, conv.data);
    const m3 = await dm.LeadListMembership.findOne({ where: { leadListId, leadId: card3.data.leadId } });
    check('An UNREVIEWED conversion does NOT promote the lead to Converted', m3.status !== 'Converted', { status: m3.status });

    const progressBefore = await j(await fetch(`${BASE}/call/campaigns/${campaignId}/progress`, { headers: mgrAuth }));
    check('Unreviewed conversions accrue NO billing', progressBefore.data.billing.amountAccrued === 0, progressBefore.data.billing);

    const pending = await j(await fetch(`${BASE}/call/campaigns/${campaignId}/pending-conversions`, { headers: mgrAuth }));
    check('The claim appears in the manager review inbox', pending.data.length === 1 && pending.data[0].leadId === card3.data.leadId, pending.data);

    // Reject requires a reason
    const noReason = await fetch(`${BASE}/call/remarks/${conv.data.id}/review`, {
      method: 'PATCH', headers: { ...mgrAuth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirmed: false })
    });
    check('Rejecting a conversion without a reason is refused (400)', noReason.status === 400);

    // Confirm it
    const confirmRes = await fetch(`${BASE}/call/remarks/${conv.data.id}/review`, {
      method: 'PATCH', headers: { ...mgrAuth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirmed: true })
    });
    check('Manager confirms the conversion', confirmRes.status === 200, await confirmRes.json());
    const m3After = await dm.LeadListMembership.findOne({ where: { leadListId, leadId: card3.data.leadId } });
    check('Confirmation promotes the lead to Converted', m3After.status === 'Converted', { status: m3After.status });

    const progressAfter = await j(await fetch(`${BASE}/call/campaigns/${campaignId}/progress`, { headers: mgrAuth }));
    check('Confirmed conversion accrues billing (1 x $8)', progressAfter.data.billing.amountAccrued === 8, progressAfter.data.billing);

    const reReview = await fetch(`${BASE}/call/remarks/${conv.data.id}/review`, {
      method: 'PATCH', headers: { ...mgrAuth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirmed: false, rejectionReason: 'changed my mind' })
    });
    check('An already-reviewed conversion cannot be reviewed again (422)', reReview.status === 422);

    // ---- Live contactability: DNC mid-campaign skips the lead -----------
    const remainingCl = await dm.CampaignLead.findOne({
      where: { campaignId, assignedExecutiveId: exec2.id, queueStatus: 'pending' }
    });
    check('Setup: exec2 still has a pending lead', Boolean(remainingCl), { remainingCl });

    await fetch(`${BASE}/leads/${remainingCl.leadId}/dnc`, {
      method: 'PATCH', headers: { ...mgrAuth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientId, dnc: true })
    });
    const afterDnc = await j(await fetch(`${BASE}/call/campaigns/${campaignId}/next`, { headers: exec2Auth }));
    check('A lead marked DNC after freeze is never served (queue exhausted)', afterDnc.queueExhausted === true, afterDnc);
    const dncCl = await dm.CampaignLead.findByPk(remainingCl.id);
    check('The DNC lead is retired as skipped, not left pending', dncCl.queueStatus === 'skipped', { q: dncCl.queueStatus });

    // ---- Manager progress rollup ---------------------------------------
    const prog = await j(await fetch(`${BASE}/call/campaigns/${campaignId}/progress`, { headers: mgrAuth }));
    check('Progress reports both executives', prog.data.executives.length === 2, prog.data.executives);
    check('Progress totals match the frozen audience (4)', prog.data.queue.total === 4, prog.data.queue);
    const rajStats = prog.data.executives.find((e) => e.name.startsWith('Raj'));
    check('Per-executive call counts are tracked', rajStats.callsLogged >= 4, rajStats);

    // ---- Paused campaign closes the queue -------------------------------
    await fetch(`${BASE}/campaigns/${campaignId}/pause`, { method: 'PATCH', headers: mgrAuth });
    const pausedNext = await fetch(`${BASE}/call/campaigns/${campaignId}/next`, { headers: exec1Auth });
    check('A paused campaign will not serve leads (422)', pausedNext.status === 422);
    await fetch(`${BASE}/campaigns/${campaignId}/resume`, { method: 'PATCH', headers: mgrAuth });

    // ---- Forward-only status guard ----------------------------------------
    // A lead promoted to Qualified must NOT be demoted by a later automatic
    // event (e.g. a re-call that goes unanswered). Only a manual override
    // may move status backwards.
    const guardCsv = 'first_name,last_name,email,phone,company,job_title,industry,source\n' +
      'Guard,Test,guard@x.com,9,GuardCo,VP,Tech,Web\n';
    const guardForm = new FormData();
    guardForm.append('clientId', clientId);
    guardForm.append('leadListId', leadListId);
    guardForm.append('file', new Blob([guardCsv], { type: 'text/csv' }), 'g.csv');
    const guardImp = await j(await fetch(`${BASE}/leads/import`, { method: 'POST', headers: mgrAuth, body: guardForm }));
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 250));
      const st = await j(await fetch(`${BASE}/leads/imports/${guardImp.data.id}/status`, { headers: mgrAuth }));
      if (['completed', 'completed_with_errors', 'failed'].includes(st.data.status)) break;
    }
    const guardLead = (await j(await fetch(`${BASE}/leads?clientId=${clientId}`, { headers: mgrAuth })))
      .data.find((l) => l.email === 'guard@x.com');

    const guardCamp = await j(await fetch(`${BASE}/campaigns`, {
      method: 'POST', headers: { ...mgrAuth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientId, leadListId, name: 'Guard Test', type: 'call' })
    }));
    await fetch(`${BASE}/campaigns/${guardCamp.data.id}/executives`, {
      method: 'POST', headers: { ...mgrAuth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ executiveUserIds: [exec1.id] })
    });
    await fetch(`${BASE}/campaigns/${guardCamp.data.id}/approve`, { method: 'PATCH', headers: mgrAuth });

    // Promote to Qualified manually, then fire an automatic Contacted at it.
    await fetch(`${BASE}/leads/${guardLead.id}/status`, {
      method: 'PATCH', headers: { ...mgrAuth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ leadListId, status: 'Qualified' })
    });
    const guardCl = await dm.CampaignLead.findOne({ where: { campaignId: guardCamp.data.id, leadId: guardLead.id } });
    const guardRemarkRes = await fetch(`${BASE}/call/leads/${guardCl.id}/remarks`, {
      method: 'POST', headers: { ...exec1Auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ callOutcome: 'Not Answered' })
    });
    // Without this the guard assertion below would pass vacuously whenever
    // the remark failed to log at all.
    check('Guard setup: the automatic remark was actually logged', guardRemarkRes.status === 201, await guardRemarkRes.json());
    const guardM = await dm.LeadListMembership.findOne({ where: { leadListId, leadId: guardLead.id } });
    check('An automatic event cannot demote a Qualified lead back to Contacted', guardM.status === 'Qualified', { status: guardM.status });

    // A MANUAL override is still allowed to move it backwards.
    await fetch(`${BASE}/leads/${guardLead.id}/status`, {
      method: 'PATCH', headers: { ...mgrAuth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ leadListId, status: 'Contacted' })
    });
    const guardM2 = await dm.LeadListMembership.findOne({ where: { leadListId, leadId: guardLead.id } });
    check('A manual override CAN move status backwards (manager correcting a mistake)', guardM2.status === 'Contacted', { status: guardM2.status });

    // ---- Cross-tenant -----------------------------------------------------
    await fetch(`${BASE}/auth/register`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ firstName: 'Bob', lastName: 'X', email: 'bob@rival.com', password: 'Str0ng!Pass2', confirmPassword: 'Str0ng!Pass2' })
    });
    const bob = await j(await fetch(`${BASE}/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'bob@rival.com', password: 'Str0ng!Pass2' })
    }));
    const bobProgress = await fetch(`${BASE}/call/campaigns/${campaignId}/progress`, { headers: { Authorization: `Bearer ${bob.data.accessToken}` } });
    check("Another manager gets 404 on this campaign's progress", bobProgress.status === 404);

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
