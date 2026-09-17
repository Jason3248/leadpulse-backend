'use strict';

const leadListService = require('./leadList.service.js');
const asyncHandler = require('../../utils/asyncHandler.js');

class LeadListController {
  create = asyncHandler(async (req, res) => {
    const list = await leadListService.create({
      ...req.body,
      managerId: req.user.id,
      importedByUserId: req.user.id
    });
    res.status(201).json({ success: true, data: list });
  });

  listForClient = asyncHandler(async (req, res) => {
    const lists = await leadListService.listForClient(req.query.clientId, req.user.id);
    res.status(200).json({ success: true, data: lists });
  });

  getById = asyncHandler(async (req, res) => {
    const list = await leadListService.getById(req.params.id, req.user.id);
    res.status(200).json({ success: true, data: list });
  });

  archive = asyncHandler(async (req, res) => {
    const list = await leadListService.archive(req.params.id, req.user.id);
    res.status(200).json({ success: true, data: list });
  });
}

module.exports = LeadListController;
