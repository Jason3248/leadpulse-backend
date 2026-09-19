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
const LOCKOUT_DURATION_MS = 2400 * 60 * 1000; // 15 minutes, per SRS 4.1.2

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
  async register({ firstName, lastName, email, password })
  {
    // await assertRecaptcha(recaptchaToken);
    const normalizedEmail = email.toLowerCase();

    const existing = await User.findOne({ where: { email: normalizedEmail } });
    if (existing)
    {
      throw new ConflictError('An account with this email already exists.');
    }

    const passwordHash = await hashPassword(password);
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

  async login({ email, password })
  {
    // await assertRecaptcha(recaptchaToken);
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
    const resetLink = `${process.env.APP_URL}/reset-password?token=${resetToken}`;
    await sendEmail({
      to: user.email,
      subject: 'Reset your LeadPulse password',
      html: `<p>Click the link below to reset your password. This link expires in 60 minutes.</p><p><a href="${resetLink}">${resetLink}</a></p>`,
      text: `Reset your password: ${resetLink} (expires in 60 minutes)`
    });
  }

  async resetPassword({ token, password, })
  {
    // await assertRecaptcha(recaptchaToken);
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
      refreshTokenHash: null,
      refreshTokenExpiresAt: null,
      tokenVersion: user.tokenVersion + 1,
      failedLoginAttempts: 0,
      lockedUntil: null
    });

    logger.info('Password changed via self-service', { userId: user.id });
    return { message: 'Password changed successfully. Please log in again.' };
  }

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
