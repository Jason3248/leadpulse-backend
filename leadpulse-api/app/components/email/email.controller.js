'use strict';

const dispatchService = require('./emailDispatch.service.js');
const analyticsService = require('./emailAnalytics.service.js');
const { trackingService, TRACKING_PIXEL } = require('./tracking.service.js');
const asyncHandler = require('../../utils/asyncHandler.js');

class EmailController
{
  // --- Dispatch (authenticated) ----------------------------------------

  startDispatch = asyncHandler(async (req, res) =>
  {
    const job = await dispatchService.startDispatch(req.params.campaignId, req.user);
    // 202: accepted and running, not finished — the caller polls the job.
    res.status(202).json({ success: true, data: job });
  });

  dispatchStatus = asyncHandler(async (req, res) =>
  {
    const job = await dispatchService.getStatus(req.params.jobId, req.user);
    res.status(200).json({ success: true, data: job });
  });

  dispatchHistory = asyncHandler(async (req, res) =>
  {
    const jobs = await dispatchService.listForCampaign(req.params.campaignId, req.user);
    res.status(200).json({ success: true, data: jobs });
  });

  analytics = asyncHandler(async (req, res) =>
  {
    const data = await analyticsService.campaignAnalytics(req.params.campaignId, req.user.id);
    res.status(200).json({ success: true, data });
  });

  // --- Tracking (public — hit by email clients, no session) -------------
  // These never reveal whether a token was valid: an invalid open still
  // returns a pixel, an invalid click still redirects. Anything else would
  // make them an enumeration oracle.

  trackOpen = asyncHandler(async (req, res) =>
  {
    const pixel = await trackingService.recordOpen(req.query.token);
    res.set({
      'Content-Type': 'image/gif',
      'Cache-Control': 'no-store, no-cache, must-revalidate, private',
      Pragma: 'no-cache'
    });
    res.status(200).send(pixel || TRACKING_PIXEL);
  });

  trackClick = asyncHandler(async (req, res) =>
  {
    const fallback = process.env.APP_URL || 'http://localhost:4000';
    const target = req.query.url;
    const resolved = await trackingService.recordClick(req.query.token, target);

    // Only ever redirect to an http(s) destination — never to a
    // javascript:/data: URL that a tampered link could smuggle in.
    const safe = resolved && /^https?:\/\//i.test(resolved) ? resolved : fallback;
    res.redirect(302, safe);
  });

  // A GET on these two only ever renders a confirmation page — it never
  // performs the action. Corporate mail scanners (Safe Links, AV gateways)
  // prefetch every link in an email, so a GET that acted would let a
  // scanner silently mark leads Converted (billing the client for a
  // conversion that never happened) or unsubscribe a prospect who never
  // asked. The action requires the POST below, which a prefetch never
  // issues — the same reason RFC 8058 mandates POST for one-click
  // unsubscribe.

  showConversionPage = asyncHandler(async (req, res) =>
  {
    const token = String(req.query.token || '').replace(/[^a-f0-9]/gi, '');
    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
    res.redirect(`${frontendUrl}/public/convert?token=${token}`);
  });

  trackConversion = asyncHandler(async (req, res) =>
  {
    const result = await trackingService.recordConversion(req.body.token || req.query.token);
    res.status(200).json({ success: true, converted: result });
  });

  showUnsubscribePage = asyncHandler(async (req, res) =>
  {
    const token = String(req.query.token || '').replace(/[^a-f0-9]/gi, '');
    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
    res.redirect(`${frontendUrl}/public/unsubscribe?token=${token}`);
  });

  trackUnsubscribe = asyncHandler(async (req, res) =>
  {
    const result = await trackingService.recordUnsubscribe(req.body.token || req.query.token);
    res.status(200).json({ success: true, unsubscribed: result });
  });

  webhook = asyncHandler(async (req, res) =>
  {
    const result = await trackingService.handleWebhookEvents(req.body);
    // Always 200: a provider retries on non-2xx, and an event we can't
    // match (an old token, a deleted campaign) is not something a retry
    // would ever fix.
    res.status(200).json({ success: true, data: result });
  });
}

module.exports = EmailController;
