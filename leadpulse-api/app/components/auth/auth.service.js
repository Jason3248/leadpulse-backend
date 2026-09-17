'use strict';

const { User, constants } = require('leadpulse-data-model');
const { hashPassword, comparePassword } = require('../../utils/password.util.js');
const {
  generateAccessToken,
  generateOpaqueToken,
  hashOpaqueToken,
  REFRESH_TOKEN_TTL_MS,
  RESET_TOKEN_TTL_MS
} = require('../../utils/token.util.js');
const { ConflictError, UnauthorizedError, ForbiddenError, NotFoundError } = require('../../lib');
const { sendEmail } = require('../../utils/emailServiceClient.js');
const notifications = require('../notification/notification.service.js');
const logger = require('../../configs/logger.js');
const { assertRecaptcha } = require('../../utils/recaptcha.util.js');

const MAX_LOGIN_ATTEMPTS = 5;
const LOCKOUT_DURATION_MS = 15 * 60 * 1000; // 15 minutes, per SRS 4.1.2

// Controllers should never see raw model instances — this is the one place
// that decides what a "user" looks like to the outside world. No hashes, no
// counters, no lockout state.
const toPublicUser = (user) => ({
  id: user.id,
  role: user.role,
  firstName: user.firstName,
  lastName: user.lastName,
  email: user.email,
  managerId: user.managerId,
  clientId: user.clientId
});

class AuthService
{
  async register({ firstName, lastName, email, password, recaptchaToken })
  {
    await assertRecaptcha(recaptchaToken);
    const normalizedEmail = email.toLowerCase();

    const existing = await User.findOne({ where: { email: normalizedEmail } });
    if (existing)
    {
      // Registration is the one auth flow where we DO confirm an account
      // exists — the person needs actionable feedback (log in instead, or
      // use a different email). Enumeration protection matters at login and
      // password reset, not here.
      throw new ConflictError('An account with this email already exists.');
    }

    const passwordHash = await hashPassword(password);

    // Self-registration always creates a Campaign Manager — the registering
    // user becomes the tenant boundary for their own agency workspace.
    // Executive and Client accounts are created by a Manager, not self-registered.
    const user = await User.create({
      role: constants.ROLES.CAMPAIGN_MANAGER,
      firstName,
      lastName,
      email: normalizedEmail,
      passwordHash
    });

    logger.info('New Campaign Manager registered', { userId: user.id });
    await notifications.managerWelcome(user);

    return { user: toPublicUser(user) };
  }

  async login({ email, password, recaptchaToken })
  {
    await assertRecaptcha(recaptchaToken);
    const normalizedEmail = email.toLowerCase();
    const user = await User.unscoped().findOne({ where: { email: normalizedEmail } });

    // Same generic message whether the email doesn't exist or the password
    // is wrong — never reveal which one failed.
    const invalidCredentials = () => new UnauthorizedError('Invalid email or password.');

    if (!user) throw invalidCredentials();

    if (user.lockedUntil && user.lockedUntil > new Date())
    {
      throw new ForbiddenError(
        'This account is temporarily locked due to repeated failed login attempts. Please try again later.'
      );
    }

    if (!user.isActive)
    {
      throw new ForbiddenError('This account has been deactivated. Please contact your Campaign Manager.');
    }

    const passwordMatches = await comparePassword(password, user.passwordHash);
    if (!passwordMatches)
    {
      const attempts = user.failedLoginAttempts + 1;
      const update = { failedLoginAttempts: attempts };
      if (attempts >= MAX_LOGIN_ATTEMPTS)
      {
        update.lockedUntil = new Date(Date.now() + LOCKOUT_DURATION_MS);
        update.failedLoginAttempts = 0;
      }
      await user.update(update);
      throw invalidCredentials();
    }

    const refreshToken = generateOpaqueToken();
    await user.update({
      failedLoginAttempts: 0,
      lockedUntil: null,
      lastLoginAt: new Date(),
      refreshTokenHash: hashOpaqueToken(refreshToken),
      refreshTokenExpiresAt: new Date(Date.now() + REFRESH_TOKEN_TTL_MS)
    });

    const accessToken = generateAccessToken(user);

    return { user: toPublicUser(user), accessToken, refreshToken };
  }

  async refresh(refreshToken)
  {
    if (!refreshToken) throw new UnauthorizedError('Refresh token missing.');

    const tokenHash = hashOpaqueToken(refreshToken);
    const user = await User.unscoped().findOne({ where: { refreshTokenHash: tokenHash } });

    if (!user || !user.refreshTokenExpiresAt || user.refreshTokenExpiresAt < new Date())
    {
      throw new UnauthorizedError('Session expired. Please log in again.');
    }
    if (!user.isActive)
    {
      throw new ForbiddenError('This account has been deactivated.');
    }

    // Rotate on every renewal — limits how long a stolen refresh token stays useful.
    const newRefreshToken = generateOpaqueToken();
    await user.update({
      refreshTokenHash: hashOpaqueToken(newRefreshToken),
      refreshTokenExpiresAt: new Date(Date.now() + REFRESH_TOKEN_TTL_MS)
    });

    const accessToken = generateAccessToken(user);

    return { accessToken, refreshToken: newRefreshToken };
  }

  async logout(userId)
  {
    const user = await User.findByPk(userId);
    if (!user) return;

    // Bump tokenVersion so any access token already issued for this session
    // is rejected immediately by the auth middleware, not just once it
    // naturally expires 15 minutes from now.
    await user.update({
      refreshTokenHash: null,
      refreshTokenExpiresAt: null,
      tokenVersion: user.tokenVersion + 1
    });
  }

  async forgotPassword(email)
  {
    const normalizedEmail = email.toLowerCase();
    const user = await User.findOne({ where: { email: normalizedEmail } });

    // Deliberately do NOT throw NotFoundError — this flow must never reveal
    // whether an email is registered.
    if (!user)
    {
      logger.info('Password reset requested for an unregistered email');
      return;
    }

    const resetToken = generateOpaqueToken();
    await user.update({
      resetTokenHash: hashOpaqueToken(resetToken),
      resetTokenExpiresAt: new Date(Date.now() + RESET_TOKEN_TTL_MS)
    });

    // Sent via leadpulse-email-service — see emailServiceClient.js. That
    // service currently stubs delivery with a log rather than a real send
    // (no SendGrid account wired up yet per SRS 4.10), but the call site
    // here won't need to change when real delivery is added.
    const resetLink = `${process.env.APP_URL}/reset-password?token=${resetToken}`;
    await sendEmail({
      to: user.email,
      subject: 'Reset your LeadPulse password',
      html: `<p>Click the link below to reset your password. This link expires in 60 minutes.</p><p><a href="${resetLink}">${resetLink}</a></p>`,
      text: `Reset your password: ${resetLink} (expires in 60 minutes)`
    });
  }

  async resetPassword({ token, password, recaptchaToken })
  {
    await assertRecaptcha(recaptchaToken);
    const tokenHash = hashOpaqueToken(token);
    const user = await User.unscoped().findOne({ where: { resetTokenHash: tokenHash } });

    if (!user || !user.resetTokenExpiresAt || user.resetTokenExpiresAt < new Date())
    {
      throw new UnauthorizedError('This reset link is invalid or has expired.');
    }

    const passwordHash = await hashPassword(password);

    await user.update({
      passwordHash,
      resetTokenHash: null,
      resetTokenExpiresAt: null,
      // Per SRS 4.1.5: all refresh tokens for the user are invalidated on reset.
      refreshTokenHash: null,
      refreshTokenExpiresAt: null,
      // Also invalidates any access token issued before this point.
      tokenVersion: user.tokenVersion + 1,
      // Successfully resetting via a mailed token is a stronger proof of
      // identity than the lockout mechanism was guarding against — don't
      // leave someone locked out for 15 more minutes after they've just
      // proven they own the account.
      failedLoginAttempts: 0,
      lockedUntil: null
    });

    logger.info('Password reset completed', { userId: user.id });
  }

  async getCurrentUser(userId)
  {
    const user = await User.findByPk(userId);
    if (!user) throw new NotFoundError('User not found.');
    return toPublicUser(user);
  }

  /**
   * Self-service password change for an already-authenticated user of ANY
   * role — the missing counterpart to the reset-link flow, which always
   * requires proving email access. Here, correctly typing the CURRENT
   * password is the proof of identity instead.
   *
   * Per SRS 4.11 (Client Portal Profile) and the "first-login
   * password-change prompt" implied for Executives — neither role had any
   * way to do this except the full forgot/reset-via-email round trip.
   */
  async changePassword(userId, { currentPassword, newPassword })
  {
    const user = await User.unscoped().findByPk(userId);
    if (!user) throw new NotFoundError('User not found.');

    const isCorrect = await comparePassword(currentPassword, user.passwordHash);
    if (!isCorrect)
    {
      throw new UnauthorizedError('Current password is incorrect.');
    }

    const passwordHash = await hashPassword(newPassword);

    await user.update({
      passwordHash,
      // Same session-invalidation as a reset-link completion: knowing the
      // current password is just as strong a proof of identity, so any
      // OTHER session (a stolen token, a forgotten logged-in device)
      // should stop working the moment the password changes.
      refreshTokenHash: null,
      refreshTokenExpiresAt: null,
      tokenVersion: user.tokenVersion + 1,
      failedLoginAttempts: 0,
      lockedUntil: null
    });

    logger.info('Password changed via self-service', { userId: user.id });
    return { message: 'Password changed successfully. Please log in again.' };
  }

  /**
   * Self-service profile update (display name) — the other half of the
   * same SRS 4.11 "Profile" requirement, available to every role since
   * nothing about it is client-specific.
   */
  async updateProfile(userId, { firstName, lastName })
  {
    const user = await User.findByPk(userId);
    if (!user) throw new NotFoundError('User not found.');

    await user.update({
      ...(firstName !== undefined ? { firstName } : {}),
      ...(lastName !== undefined ? { lastName } : {})
    });

    return toPublicUser(user);
  }
}

module.exports = new AuthService();
