'use strict';

const { Client } = require('leadpulse-data-model');
const { NotFoundError } = require('../../lib');
const assertClientOwnership = require('./assertClientOwnership.js');

const toPublicClient = (client) => ({
  id: client.id,
  name: client.name,
  contactPerson: client.contactPerson,
  contactEmail: client.contactEmail,
  isActive: client.isActive,
  createdAt: client.createdAt
});

class ClientService {
  async create({ managerId, name, contactPerson, contactEmail }) {
    const client = await Client.create({ managerId, name, contactPerson, contactEmail });
    return toPublicClient(client);
  }

  async list(managerId) {
    const clients = await Client.findAll({
      where: { managerId },
      order: [['createdAt', 'DESC']]
    });
    return clients.map(toPublicClient);
  }

  async getById(id, requestingUser) {
    const client = await Client.findByPk(id);

    // Not found is the correct response for a cross-tenant access attempt
    // too — never confirm another Manager's client exists (same enumeration
    // principle we applied to login/password reset). Viewing is always
    // allowed regardless of active status — a Manager needs to see a
    // deactivated client to reactivate it.
    if (!client) throw new NotFoundError('Client not found.');

    const isOwningManager = requestingUser.role === 'campaign_manager' && client.managerId === requestingUser.id;
    const isOwnClientRecord = requestingUser.role === 'client' && requestingUser.clientId === client.id;

    if (!isOwningManager && !isOwnClientRecord) {
      throw new NotFoundError('Client not found.');
    }

    return toPublicClient(client);
  }

  async update(id, managerId, updates) {
    // Editing basic info doesn't create new business activity, so this is
    // allowed even while deactivated.
    const client = await assertClientOwnership(id, managerId, { requireActive: false });
    await client.update(updates);
    return toPublicClient(client);
  }

  async deactivate(id, managerId) {
    const client = await assertClientOwnership(id, managerId, { requireActive: false });
    await client.update({ isActive: false });
    return toPublicClient(client);
  }

  async reactivate(id, managerId) {
    const client = await assertClientOwnership(id, managerId, { requireActive: false });
    await client.update({ isActive: true });
    return toPublicClient(client);
  }
}

module.exports = new ClientService();
