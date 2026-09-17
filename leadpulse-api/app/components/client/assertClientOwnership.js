'use strict';

const { Client } = require('leadpulse-data-model');
const { NotFoundError, ForbiddenError } = require('../../lib');

/**
 * Shared ownership check, used by every service that scopes work to a
 * Client (Client itself, LeadList, Lead, and later Campaign).
 *
 * requireActive defaults to true, meaning: creating new business activity
 * (a new list, an import, a DNC/status change) is blocked for a
 * deactivated client. Reads (listing, viewing, archiving a list as a
 * wind-down action) pass requireActive:false, since a Manager needs to be
 * able to review — and reactivate — a deactivated client's data.
 */
async function assertClientOwnership(clientId, managerId, { requireActive = true } = {}) {
  const client = await Client.findOne({ where: { id: clientId, managerId } });
  if (!client) throw new NotFoundError('Client not found.');
  if (requireActive && !client.isActive) {
    throw new ForbiddenError('This client account has been deactivated. Reactivate it before making changes.');
  }
  return client;
}

module.exports = assertClientOwnership;
