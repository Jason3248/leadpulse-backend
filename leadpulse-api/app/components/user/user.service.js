'use strict';

const crypto = require('crypto');
const {
  User,
  Client,
  Campaign,
  CampaignExecutive,
  CampaignLead,
  CallRemark,
  Sequelize,
  constants
} = require('leadpulse-data-model');
const { ConflictError, NotFoundError, BusinessRuleError } = require('../../lib');
const { hashPassword } = require('../../utils/password.util.js');
const { generateOpaqueToken, hashOpaqueToken, RESET_TOKEN_TTL_MS } = require('../../utils/token.util.js');
const { sendEmail } = require('../../utils/emailServiceClient.js');
const notifications = require('../notification/notification.service.js');
const assertClientOwnership = require('../client/assertClientOwnership.js');
const logger = require('../../configs/logger.js');

const { Op } = Sequelize;
const { ROLES, QUEUE_STATUS } = constants;

/**
 * Generates a temporary password that satisfies the SRS password policy by
 * construction, rather than generating randomly and hoping it passes.
 */
function generateTemporaryPassword() {
  const upper = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  const lower = 'abcdefghijkmnopqrstuvwxyz';
  const digits = '23456789';
  const symbols = '!@#$%&*';
  const pick = (set) => set[crypto.randomInt(0, set.length)];

  const chars = [pick(upper), pick(lower), pick(digits), pick(symbols)];
  const all = upper + lower + digits + symbols;
  while (chars.length < 12) chars.push(pick(all));

  // Fisher-Yates, so the guaranteed characters aren't always in positions 0-3.
  for (let i = chars.length - 1; i > 0; i--) {
    const jdx = crypto.randomInt(0, i + 1);
    [chars[i], chars[jdx]] = [chars[jdx], chars[i]];
  }
  return chars.join('');
}

const toPublicUser = (user) => ({
  id: user.id,
  role: user.role,
  firstName: user.firstName,
  lastName: user.lastName,
  email: user.email,
  clientId: user.clientId,
  isActive: user.isActive,
  lastLoginAt: user.lastLoginAt,
  createdAt: user.createdAt
});

class UserService {
  /**
   * Create an Executive under this Manager (SRS 4.2.1). The temporary
   * password is emailed and never persisted in plain form — it exists in
   * memory only long enough to hash it and send it.
   */
  async createExecutive({ managerId, firstName, lastName, email, temporaryPassword }) {
    const normalizedEmail = email.toLowerCase();

    const existing = await User.findOne({ where: { email: normalizedEmail } });
    if (existing) throw new ConflictError('An account with this email already exists.');

    const plainPassword = temporaryPassword || generateTemporaryPassword();
    const passwordHash = await hashPassword(plainPassword);

    const executive = await User.create({
      role: ROLES.EXECUTIVE,
      managerId,
      firstName,
      lastName,
      email: normalizedEmail,
      passwordHash
    });

    await notifications.executiveCredentials(executive, plainPassword);
    logger.info('Executive created', { executiveId: executive.id, managerId });

    return toPublicUser(executive);
  }

  /**
   * Create a read-only Client portal login (SRS 4.11). Scoped to one
   * Client, which must belong to this Manager.
   */
  async createClientUser({ managerId, clientId, firstName, lastName, email, temporaryPassword }) {
    const client = await assertClientOwnership(clientId, managerId, { requireActive: true });

    const normalizedEmail = email.toLowerCase();
    const existing = await User.findOne({ where: { email: normalizedEmail } });
    if (existing) throw new ConflictError('An account with this email already exists.');

    const plainPassword = temporaryPassword || generateTemporaryPassword();
    const passwordHash = await hashPassword(plainPassword);

    const portalUser = await User.create({
      role: ROLES.CLIENT,
      managerId,
      clientId,
      firstName,
      lastName,
      email: normalizedEmail,
      passwordHash
    });

    await notifications.clientPortalCredentials(portalUser, client.name, plainPassword);
    logger.info('Client portal user created', { userId: portalUser.id, clientId });

    return toPublicUser(portalUser);
  }

  /** The Team page (SRS 4.2.3): executives with their current workload. */
  async listExecutives(managerId) {
    const executives = await User.findAll({
      where: { managerId, role: ROLES.EXECUTIVE },
      order: [['createdAt', 'DESC']]
    });

    return Promise.all(
      executives.map(async (exec) => {
        const activeAssignments = await CampaignExecutive.findAll({
          where: { executiveUserId: exec.id, isActive: true },
          attributes: ['campaignId']
        });
        const campaignIds = activeAssignments.map((a) => a.campaignId);

        const campaigns = campaignIds.length
          ? await Campaign.findAll({
              where: { id: { [Op.in]: campaignIds } },
              attributes: ['id', 'name', 'status']
            })
          : [];

        const callsLogged = await CallRemark.count({ where: { executiveUserId: exec.id } });

        // Surfaced because deactivating an executive who still holds open
        // leads strands them — the Manager needs to see this before acting.
        const openLeads = campaignIds.length
          ? await CampaignLead.count({
              where: {
                assignedExecutiveId: exec.id,
                queueStatus: {
                  [Op.in]: [QUEUE_STATUS.PENDING, QUEUE_STATUS.IN_PROGRESS, QUEUE_STATUS.CALLED]
                }
              }
            })
          : 0;

        return {
          ...toPublicUser(exec),
          assignedCampaigns: campaigns.map((c) => ({ id: c.id, name: c.name, status: c.status })),
          callsLogged,
          openLeads
        };
      })
    );
  }

  async listClientUsers(managerId, clientId) {
    if (clientId) await assertClientOwnership(clientId, managerId, { requireActive: false });

    const where = { managerId, role: ROLES.CLIENT };
    if (clientId) where.clientId = clientId;

    const users = await User.findAll({ where, order: [['createdAt', 'DESC']] });
    return users.map(toPublicUser);
  }

  /**
   * Deactivate a managed user. Bumping tokenVersion is what makes this
   * immediate: without it, an already-issued access token would keep
   * working until it expired on its own.
   */
  async setActive(userId, managerId, isActive) {
    const user = await this._getManagedUser(userId, managerId);

    if (user.isActive === isActive) {
      return toPublicUser(user);
    }

    if (!isActive && user.role === ROLES.EXECUTIVE) {
      // Documented, deliberate limitation: we warn rather than block or
      // auto-reassign. The Manager decides what happens to the leads.
      const openLeads = await CampaignLead.count({
        where: {
          assignedExecutiveId: user.id,
          queueStatus: { [Op.in]: [QUEUE_STATUS.PENDING, QUEUE_STATUS.IN_PROGRESS, QUEUE_STATUS.CALLED] }
        }
      });
      if (openLeads > 0) {
        logger.warn('Deactivating an executive who still holds open leads', { userId: user.id, openLeads });
      }
    }

    await user.update({
      isActive,
      ...(isActive ? {} : { tokenVersion: user.tokenVersion + 1, refreshTokenHash: null, refreshTokenExpiresAt: null })
    });

    return toPublicUser(user);
  }

  /**
   * Manager-triggered password reset (SRS 4.2.3). Issues the same
   * single-use token as the self-service flow rather than setting a new
   * password directly — the Manager never learns the user's password.
   */
  async triggerPasswordReset(userId, managerId) {
    const user = await this._getManagedUser(userId, managerId);
    if (!user.isActive) {
      throw new BusinessRuleError('This account is deactivated. Reactivate it before resetting the password.');
    }

    const resetToken = generateOpaqueToken();
    await user.update({
      resetTokenHash: hashOpaqueToken(resetToken),
      resetTokenExpiresAt: new Date(Date.now() + RESET_TOKEN_TTL_MS)
    });

    const resetLink = `${process.env.APP_URL || 'http://localhost:3000'}/reset-password?token=${resetToken}`;
    await sendEmail({
      to: user.email,
      subject: 'Reset your LeadPulse password',
      html: `<p>Your manager has requested a password reset for your LeadPulse account.</p>
             <p><a href="${resetLink}">Set a new password</a> — this link expires in 60 minutes.</p>`,
      text: `Set a new password: ${resetLink} (expires in 60 minutes)`
    });

    logger.info('Manager-triggered password reset', { userId: user.id, managerId });
    return { message: 'A password reset link has been sent.' };
  }

  async _getManagedUser(userId, managerId) {
    const user = await User.findOne({
      where: { id: userId, managerId, role: { [Op.in]: [ROLES.EXECUTIVE, ROLES.CLIENT] } }
    });
    if (!user) throw new NotFoundError('User not found.');
    return user;
  }
}

module.exports = new UserService();
