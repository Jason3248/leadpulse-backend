'use strict';

const { LeadList, LeadListMembership, Client, Sequelize, constants } = require('leadpulse-data-model');
const { NotFoundError, ValidationError } = require('../../lib');
const assertClientOwnership = require('../client/assertClientOwnership.js');

const { Op } = Sequelize;

const toPublicLeadList = (list, leadCount) => ({
  id: list.id,
  clientId: list.clientId,
  name: list.name,
  status: list.status,
  createdAt: list.createdAt,
  ...(leadCount !== undefined ? { leadCount } : {})
});

class LeadListService {
  async create({ clientId, name, managerId, importedByUserId }) {
    // Creating a list is new business activity — blocked for a
    // deactivated client, same rule as importing leads.
    await assertClientOwnership(clientId, managerId, { requireActive: true });

    // Reuse an existing list with the same name (case-insensitive) rather
    // than silently creating a duplicate — a double-click or a retried
    // request most likely means "add to the same list", not "start a new
    // one". The DB-level unique index (migration) is the backstop for a
    // genuine race between two concurrent requests.
    const existing = await LeadList.findOne({ where: { clientId, name: { [Op.iLike]: name } } });
    if (existing) return toPublicLeadList(existing, await LeadListMembership.count({ where: { leadListId: existing.id } }));

    const list = await LeadList.create({ clientId, name, importedByUserId });
    return toPublicLeadList(list, 0);
  }

  async listForClient(clientId, managerId) {
    if (!clientId) throw new ValidationError('clientId query parameter is required.');
    await assertClientOwnership(clientId, managerId, { requireActive: false });

    const lists = await LeadList.findAll({
      where: { clientId },
      order: [['createdAt', 'DESC']]
    });

    // One extra count query per list is fine at this scale — see schema
    // notes on why we deliberately don't denormalize a leadCount column.
    const withCounts = await Promise.all(
      lists.map(async (list) => {
        const leadCount = await LeadListMembership.count({ where: { leadListId: list.id } });
        return toPublicLeadList(list, leadCount);
      })
    );

    return withCounts;
  }

  async getById(id, managerId) {
    const list = await this._getOwnedList(id, managerId);
    const leadCount = await LeadListMembership.count({ where: { leadListId: id } });
    return toPublicLeadList(list, leadCount);
  }

  async archive(id, managerId) {
    // Archiving is a wind-down action — always allowed, even for a
    // deactivated client.
    const list = await this._getOwnedList(id, managerId);
    await list.update({ status: constants.LEAD_LIST_STATUS.ARCHIVED });
    return toPublicLeadList(list);
  }

  async _getOwnedList(id, managerId) {
    const list = await LeadList.findOne({
      where: { id },
      include: [{ model: Client, as: 'client', attributes: ['id', 'managerId'] }]
    });
    if (!list || list.client.managerId !== managerId) {
      throw new NotFoundError('Lead list not found.');
    }
    return list;
  }
}

module.exports = new LeadListService();
