'use strict';

const campaignService = require('./campaign.service.js');
const asyncHandler = require('../../utils/asyncHandler.js');
const { constants } = require('leadpulse-data-model');

const { CAMPAIGN_STATUS } = constants;

class CampaignController {
  create = asyncHandler(async (req, res) => {
    const campaign = await campaignService.create(req.body, req.user.id);
    res.status(201).json({ success: true, data: campaign });
  });

  update = asyncHandler(async (req, res) => {
    const campaign = await campaignService.update(req.params.id, req.user.id, req.body);
    res.status(200).json({ success: true, data: campaign });
  });

  list = asyncHandler(async (req, res) => {
    const campaigns = await campaignService.list({ managerId: req.user.id, ...req.query });
    res.status(200).json({ success: true, data: campaigns });
  });

  getById = asyncHandler(async (req, res) => {
    const campaign = await campaignService.getById(req.params.id, req.user.id);
    res.status(200).json({ success: true, data: campaign });
  });

  assignExecutives = asyncHandler(async (req, res) => {
    const campaign = await campaignService.assignExecutives(req.params.id, req.user.id, req.body.executiveUserIds);
    res.status(200).json({ success: true, data: campaign });
  });

  unassignExecutive = asyncHandler(async (req, res) => {
    const campaign = await campaignService.unassignExecutive(req.params.id, req.user.id, req.params.executiveId);
    res.status(200).json({ success: true, data: campaign });
  });

  reassignLeads = asyncHandler(async (req, res) => {
    const result = await campaignService.reassignLeads(
      req.params.id,
      req.user.id,
      req.body.targetExecutiveId,
      req.body.leadIds
    );
    res.status(200).json({ success: true, data: result });
  });

  approve = asyncHandler(async (req, res) => {
    const campaign = await campaignService.approve(req.params.id, req.user.id);
    res.status(200).json({ success: true, data: campaign });
  });

  pause = asyncHandler(async (req, res) => {
    const campaign = await campaignService.setStatus(req.params.id, req.user.id, CAMPAIGN_STATUS.PAUSED);
    res.status(200).json({ success: true, data: campaign });
  });

  resume = asyncHandler(async (req, res) => {
    const campaign = await campaignService.setStatus(req.params.id, req.user.id, CAMPAIGN_STATUS.ACTIVE);
    res.status(200).json({ success: true, data: campaign });
  });

  end = asyncHandler(async (req, res) => {
    const campaign = await campaignService.setStatus(req.params.id, req.user.id, CAMPAIGN_STATUS.COMPLETED);
    res.status(200).json({ success: true, data: campaign });
  });
}

module.exports = CampaignController;
