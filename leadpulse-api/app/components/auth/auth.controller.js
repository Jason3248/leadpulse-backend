'use strict';

const authService = require('./auth.service.js');
const asyncHandler = require('../../utils/asyncHandler.js');

const REFRESH_COOKIE_NAME = 'refreshToken';
const REFRESH_COOKIE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

const cookieOptions = {
  httpOnly: true,
  secure: process.env.NODE_ENV === 'production',
  sameSite: 'strict',
  maxAge: REFRESH_COOKIE_MAX_AGE_MS
};

class AuthController
{
  register = asyncHandler(async (req, res) =>
  {
    const result = await authService.register(req.body);
    res.status(201).json({ success: true, data: result });
  });

  login = asyncHandler(async (req, res) =>
  {
    const { user, accessToken, refreshToken } = await authService.login(req.body);
    res.cookie(REFRESH_COOKIE_NAME, refreshToken, cookieOptions);
    res.status(200).json({ success: true, data: { user, accessToken } });
  });

  refresh = asyncHandler(async (req, res) =>
  {
    const { accessToken, refreshToken } = await authService.refresh(req.cookies[REFRESH_COOKIE_NAME]);
    res.cookie(REFRESH_COOKIE_NAME, refreshToken, cookieOptions);
    res.status(200).json({ success: true, data: { accessToken } });
  });

  logout = asyncHandler(async (req, res) =>
  {
    await authService.logout(req.user.id);
    res.clearCookie(REFRESH_COOKIE_NAME, cookieOptions);
    res.status(200).json({ success: true, data: null });
  });

  forgotPassword = asyncHandler(async (req, res) =>
  {
    await authService.forgotPassword(req.body.email);
    // Identical response regardless of whether the email was found — no
    // enumeration signal leaks through the HTTP response either.
    res.status(200).json({
      success: true,
      data: { message: 'If an account exists for this email, a reset link has been sent.' }
    });
  });

  resetPassword = asyncHandler(async (req, res) =>
  {
    await authService.resetPassword(req.body);
    res.status(200).json({ success: true, data: { message: 'Password has been reset successfully.' } });
  });

  me = asyncHandler(async (req, res) =>
  {
    const user = await authService.getCurrentUser(req.user.id);
    res.status(200).json({ success: true, data: user });
  });

  changePassword = asyncHandler(async (req, res) =>
  {
    const result = await authService.changePassword(req.user.id, req.body);
    res.status(200).json({ success: true, data: result });
  });

  updateProfile = asyncHandler(async (req, res) =>
  {
    const user = await authService.updateProfile(req.user.id, req.body);
    res.status(200).json({ success: true, data: user });
  });
}

module.exports = AuthController;
