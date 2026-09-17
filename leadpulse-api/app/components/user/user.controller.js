'use strict';

const userService = require('./user.service.js');
const asyncHandler = require('../../utils/asyncHandler.js');

class UserController {
  createExecutive = asyncHandler(async (req, res) => {
    const executive = await userService.createExecutive({ managerId: req.user.id, ...req.body });
    res.status(201).json({ success: true, data: executive });
  });

  listExecutives = asyncHandler(async (req, res) => {
    const executives = await userService.listExecutives(req.user.id);
    res.status(200).json({ success: true, data: executives });
  });

  createClientUser = asyncHandler(async (req, res) => {
    const portalUser = await userService.createClientUser({ managerId: req.user.id, ...req.body });
    res.status(201).json({ success: true, data: portalUser });
  });

  listClientUsers = asyncHandler(async (req, res) => {
    const users = await userService.listClientUsers(req.user.id, req.query.clientId);
    res.status(200).json({ success: true, data: users });
  });

  deactivate = asyncHandler(async (req, res) => {
    const user = await userService.setActive(req.params.id, req.user.id, false);
    res.status(200).json({ success: true, data: user });
  });

  reactivate = asyncHandler(async (req, res) => {
    const user = await userService.setActive(req.params.id, req.user.id, true);
    res.status(200).json({ success: true, data: user });
  });

  resetPassword = asyncHandler(async (req, res) => {
    const result = await userService.triggerPasswordReset(req.params.id, req.user.id);
    res.status(200).json({ success: true, data: result });
  });
}

module.exports = UserController;
