'use strict';

const portalService = require('./portal.service.js');
const asyncHandler = require('../../utils/asyncHandler.js');

class PortalController {
  dashboard = asyncHandler(async (req, res) => {
    const data = await portalService.dashboard(req.user);
    res.status(200).json({ success: true, data });
  });

  sequences = asyncHandler(async (req, res) => {
    const sequences = await portalService.sequences(req.user);
    res.status(200).json({ success: true, data: sequences });
  });

  sequenceDetail = asyncHandler(async (req, res) => {
    const sequence = await portalService.sequenceDetail(req.user, req.params.id);
    res.status(200).json({ success: true, data: sequence });
  });

  campaigns = asyncHandler(async (req, res) => {
    const campaigns = await portalService.campaigns(req.user);
    res.status(200).json({ success: true, data: campaigns });
  });

  portalLeads = asyncHandler(async (req, res) => {
    const data = await portalService.portalLeads(req.user, req.query);
    res.status(200).json({ success: true, data });
  });

  billing = asyncHandler(async (req, res) => {
    const data = await portalService.billingStatement(req.user);
    res.status(200).json({ success: true, data });
  });
}

module.exports = PortalController;
