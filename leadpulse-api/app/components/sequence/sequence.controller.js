'use strict';

const sequenceService = require('./sequence.service.js');
const asyncHandler = require('../../utils/asyncHandler.js');

class SequenceController {
  create = asyncHandler(async (req, res) => {
    const sequence = await sequenceService.create(req.body, req.user.id);
    res.status(201).json({ success: true, data: sequence });
  });

  list = asyncHandler(async (req, res) => {
    const sequences = await sequenceService.list({ managerId: req.user.id, clientId: req.query.clientId });
    res.status(200).json({ success: true, data: sequences });
  });

  getById = asyncHandler(async (req, res) => {
    const rollup = await sequenceService.getById(req.params.id, req.user.id);
    res.status(200).json({ success: true, data: rollup });
  });

  update = asyncHandler(async (req, res) => {
    const sequence = await sequenceService.update(req.params.id, req.user.id, req.body);
    res.status(200).json({ success: true, data: sequence });
  });
}

module.exports = SequenceController;
