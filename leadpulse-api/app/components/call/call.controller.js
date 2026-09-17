'use strict';

const callService = require('./call.service.js');
const asyncHandler = require('../../utils/asyncHandler.js');

class CallController
{
  // --- Executive-facing -------------------------------------------------

  myCampaigns = asyncHandler(async (req, res) =>
  {
    const campaigns = await callService.myCampaigns(req.user.id);
    res.status(200).json({ success: true, data: campaigns });
  });

  nextLead = asyncHandler(async (req, res) =>
  {
    const card = await callService.getNextLead(req.params.campaignId, req.user.id);
    // Null means the queue is exhausted — a normal, expected end state, not
    // an error, so the client can show "you're done" rather than a failure.
    res.status(200).json({ success: true, data: card, queueExhausted: card === null });
  });

  logRemark = asyncHandler(async (req, res) =>
  {
    const result = await callService.logRemark(req.params.campaignLeadId, req.user.id, req.body);
    res.status(201).json({ success: true, data: result });
  });

  skip = asyncHandler(async (req, res) =>
  {
    const result = await callService.skipLead(req.params.campaignLeadId, req.user.id);
    res.status(200).json({ success: true, data: result });
  });

  leadDetail = asyncHandler(async (req, res) =>
  {
    const card = await callService.getLeadDetail(req.params.campaignLeadId, req.user.id);
    res.status(200).json({ success: true, data: card });
  });

  // --- Shared (manager sees all, executive sees their own slice) ---------

  callbacksDue = asyncHandler(async (req, res) =>
  {
    const callbacks = await callService.callbacksDue(req.params.campaignId, req.user);
    res.status(200).json({ success: true, data: callbacks });
  });

  // --- Manager-facing ---------------------------------------------------

  pendingConversions = asyncHandler(async (req, res) =>
  {
    const pending = await callService.pendingConversions(req.params.campaignId, req.user.id);
    res.status(200).json({ success: true, data: pending });
  });

  reviewConversion = asyncHandler(async (req, res) =>
  {
    const result = await callService.reviewConversion(req.params.remarkId, req.user.id, req.body);
    res.status(200).json({ success: true, data: result });
  });

  progress = asyncHandler(async (req, res) =>
  {
    const progress = await callService.progress(req.params.campaignId, req.user.id);
    res.status(200).json({ success: true, data: progress });
  });
}

module.exports = CallController;
