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

// A minimal valid PNG (1x1) as raw bytes.
const PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64'
);

async function main() {
  const api = spawnService('leadpulse-api', '/tmp/bnr_api.log');
  const upload = spawnService('leadpulse-upload-service', '/tmp/bnr_up.log');
  const emailSvc = spawnService('leadpulse-email-service', '/tmp/bnr_em.log');
  await new Promise((r) => setTimeout(r, 2500));

  try {
    const dm = require('leadpulse-data-model');

    await fetch(`${BASE}/auth/register`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ firstName: 'Asha', lastName: 'Rao', email: 'asha@acme-agency.com', password: 'Str0ng!Pass', confirmPassword: 'Str0ng!Pass' })
    });
    const login = await j(await fetch(`${BASE}/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'asha@acme-agency.com', password: 'Str0ng!Pass' })
    }));
    const mgr = { Authorization: `Bearer ${login.data.accessToken}` };

    const client = await j(await fetch(`${BASE}/clients`, {
      method: 'POST', headers: { ...mgr, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Acme Corp' })
    }));
    const clientId = client.data.id;

    const csv = 'first_name,last_name,email,phone,company,job_title,industry,source\nAnn,A,ann@x.com,1,C,VP,Tech,Web\n';
    const form = new FormData();
    form.append('clientId', clientId);
    form.append('leadListName', 'List');
    form.append('file', new Blob([csv], { type: 'text/csv' }), 'p.csv');
    const imp = await j(await fetch(`${BASE}/leads/import`, { method: 'POST', headers: mgr, body: form }));
    let impDone;
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 250));
      impDone = await j(await fetch(`${BASE}/leads/imports/${imp.data.id}/status`, { headers: mgr }));
      if (['completed', 'completed_with_errors', 'failed'].includes(impDone.data.status)) break;
    }
    const leadListId = impDone.data.leadListId;

    // An EMAIL draft campaign.
    const camp = await j(await fetch(`${BASE}/campaigns`, {
      method: 'POST', headers: { ...mgr, 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientId, leadListId, name: 'Banner Blast', type: 'email', subjectLine: 'Hi', senderName: 'Acme', emailBodyHtml: '<p>Hello {{first_name}}</p>' })
    }));
    const campaignId = camp.data.id;

    // ---- Presign -------------------------------------------------------
    const presignRes = await fetch(`${BASE}/uploads/banner-url`, {
      method: 'POST', headers: { ...mgr, 'Content-Type': 'application/json' },
      body: JSON.stringify({ campaignId, contentType: 'image/png', fileSize: PNG_BYTES.length })
    });
    const presign = await presignRes.json();
    check('Manager gets a presigned banner upload URL', presignRes.status === 200 && Boolean(presign.data.uploadUrl && presign.data.publicUrl), presign);
    check('The upload key follows the SRS images/{campaignId}/{uuid}.ext layout', /^images\/[^/]+\/[^/]+\.png$/.test(presign.data.key), presign.data.key);
    check('The upload method is PUT (direct upload, bypasses the app for S3)', presign.data.method === 'PUT', presign.data);

    // ---- Direct upload (local driver stand-in for S3) -----------------
    const putRes = await fetch(presign.data.uploadUrl, {
      method: 'PUT', headers: { 'Content-Type': 'image/png' }, body: PNG_BYTES
    });
    check('The browser can PUT the image bytes directly to the upload URL', putRes.status === 200, await putRes.text());

    // ---- The image is retrievable at its public URL -------------------
    const getRes = await fetch(presign.data.publicUrl);
    const gotBytes = Buffer.from(await getRes.arrayBuffer());
    check('The uploaded image is served back at its public URL', getRes.status === 200 && getRes.headers.get('content-type') === 'image/png', getRes.status);
    check('The served bytes match what was uploaded', gotBytes.equals(PNG_BYTES), { got: gotBytes.length, sent: PNG_BYTES.length });

    // ---- Attach to the campaign and confirm it renders in the email ---
    await fetch(`${BASE}/campaigns/${campaignId}`, {
      method: 'PATCH', headers: { ...mgr, 'Content-Type': 'application/json' },
      body: JSON.stringify({ bannerImageUrl: presign.data.publicUrl })
    });
    const updated = await j(await fetch(`${BASE}/campaigns/${campaignId}`, { headers: mgr }));
    check('The banner URL is stored on the campaign', updated.data.bannerImageUrl === presign.data.publicUrl, updated.data.bannerImageUrl);

    const { buildEmailHtml } = require('./leadpulse-api/app/components/email/emailRenderer.js');
    const rendered = buildEmailHtml({
      campaign: { emailBodyHtml: '<p>Hello</p>', name: 'x', bannerImageUrl: presign.data.publicUrl },
      lead: { firstName: 'Ann', lastName: 'A', company: 'C' },
      token: 'T', trackingBaseUrl: 'http://localhost:4000/api/v1'
    });
    check('The banner renders as an <img> at the top of the email body', rendered.includes(`<img src="${presign.data.publicUrl}"`), rendered.slice(0, 120));

    // ---- Guards --------------------------------------------------------
    const badType = await fetch(`${BASE}/uploads/banner-url`, {
      method: 'POST', headers: { ...mgr, 'Content-Type': 'application/json' },
      body: JSON.stringify({ campaignId, contentType: 'application/pdf', fileSize: 1000 })
    });
    check('A non-image content type is rejected (400)', badType.status === 400);

    const tooBig = await fetch(`${BASE}/uploads/banner-url`, {
      method: 'POST', headers: { ...mgr, 'Content-Type': 'application/json' },
      body: JSON.stringify({ campaignId, contentType: 'image/png', fileSize: 6 * 1024 * 1024 })
    });
    check('An oversized banner (>5MB) is rejected (400)', tooBig.status === 400);

    // Call campaigns have no banner.
    const callCamp = await j(await fetch(`${BASE}/campaigns`, {
      method: 'POST', headers: { ...mgr, 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientId, leadListId, name: 'Call One', type: 'call' })
    }));
    const bannerOnCall = await fetch(`${BASE}/uploads/banner-url`, {
      method: 'POST', headers: { ...mgr, 'Content-Type': 'application/json' },
      body: JSON.stringify({ campaignId: callCamp.data.id, contentType: 'image/png', fileSize: 1000 })
    });
    check('A banner cannot be requested for a call campaign (422)', bannerOnCall.status === 422);

    // Not while approved (audience frozen).
    await fetch(`${BASE}/campaigns/${campaignId}/approve`, { method: 'PATCH', headers: mgr });
    const bannerOnApproved = await fetch(`${BASE}/uploads/banner-url`, {
      method: 'POST', headers: { ...mgr, 'Content-Type': 'application/json' },
      body: JSON.stringify({ campaignId, contentType: 'image/png', fileSize: 1000 })
    });
    check('A banner cannot be changed once the campaign is approved (422)', bannerOnApproved.status === 422);

    // ---- Security ------------------------------------------------------
    // Path-injection attempt on the local receiver.
    const evilPut = await fetch(`${BASE}/uploads/local?key=${encodeURIComponent('../../etc/evil.png')}`, {
      method: 'PUT', headers: { 'Content-Type': 'image/png' }, body: PNG_BYTES
    });
    check('A malformed/injection upload key is rejected (400)', evilPut.status === 400);

    // Another manager cannot presign against this campaign.
    await fetch(`${BASE}/auth/register`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ firstName: 'Bob', lastName: 'X', email: 'bob@rival.com', password: 'Str0ng!Pass2', confirmPassword: 'Str0ng!Pass2' })
    });
    const bob = await j(await fetch(`${BASE}/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'bob@rival.com', password: 'Str0ng!Pass2' })
    }));
    const draftCamp2 = await j(await fetch(`${BASE}/campaigns`, {
      method: 'POST', headers: { ...mgr, 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientId, leadListId, name: 'Another Draft', type: 'email', subjectLine: 'H', senderName: 'A', emailBodyHtml: '<p>x</p>' })
    }));
    const crossPresign = await fetch(`${BASE}/uploads/banner-url`, {
      method: 'POST', headers: { Authorization: `Bearer ${bob.data.accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ campaignId: draftCamp2.data.id, contentType: 'image/png', fileSize: 1000 })
    });
    check("Another manager gets 404 presigning against someone else's campaign", crossPresign.status === 404);

    // An executive cannot presign banners at all.
    const execUpload = await fetch(`${BASE}/uploads/banner-url`, {
      method: 'POST', headers: { Authorization: `Bearer ${bob.data.accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ campaignId, contentType: 'image/png', fileSize: 1000 })
    });
    check('Presign is scoped so a non-owner never reaches another campaign (404)', execUpload.status === 404);

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
