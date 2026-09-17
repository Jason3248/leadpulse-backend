'use strict';

const clientService = require('./client.service.js');
const asyncHandler = require('../../utils/asyncHandler.js');

class ClientController {
  create = asyncHandler(async (req, res) => {
    const client = await clientService.create({ managerId: req.user.id, ...req.body });
    res.status(201).json({ success: true, data: client });
  });

  list = asyncHandler(async (req, res) => {
    const clients = await clientService.list(req.user.id);
    res.status(200).json({ success: true, data: clients });
  });

  getById = asyncHandler(async (req, res) => {
    const client = await clientService.getById(req.params.id, req.user);
    res.status(200).json({ success: true, data: client });
  });

  update = asyncHandler(async (req, res) => {
    const client = await clientService.update(req.params.id, req.user.id, req.body);
    res.status(200).json({ success: true, data: client });
  });

  deactivate = asyncHandler(async (req, res) => {
    const client = await clientService.deactivate(req.params.id, req.user.id);
    res.status(200).json({ success: true, data: client });
  });

  reactivate = asyncHandler(async (req, res) => {
    const client = await clientService.reactivate(req.params.id, req.user.id);
    res.status(200).json({ success: true, data: client });
  });
}

module.exports = ClientController;
