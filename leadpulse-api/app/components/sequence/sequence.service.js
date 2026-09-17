'use strict';

const { Sequence, Client, LeadList, Campaign, Sequelize, constants } = require('leadpulse-data-model');
const { NotFoundError, BusinessRuleError } = require('../../lib');
const assertClientOwnership = require('../client/assertClientOwnership.js');
const { sequenceRollup } = require('./sequenceBilling.service.js');

const { Op } = Sequelize;

const toPublicSequence = (s) => ({
  id: s.id,
  clientId: s.clientId,
  leadListId: s.leadListId,
  name: s.name,
  description: s.description,
  pricingModel: s.pricingModel,
  retainerAmount: s.retainerAmount != null ? Number(s.retainerAmount) : null,
  ratePerLead: s.ratePerLead != null ? Number(s.ratePerLead) : null,
  createdAt: s.createdAt
});

class SequenceService {
  async create(data, managerId) {
    await assertClientOwnership(data.clientId, managerId, { requireActive: true });

    const list = await LeadList.findOne({ where: { id: data.leadListId, clientId: data.clientId } });
    if (!list) throw new NotFoundError('Lead list not found for this client.');
    if (list.status === constants.LEAD_LIST_STATUS.ARCHIVED) {
      throw new BusinessRuleError('That lead list is archived and cannot be used for a new sequence.');
    }

    const sequence = await Sequence.create({
      clientId: data.clientId,
      leadListId: data.leadListId,
      name: data.name,
      description: data.description || null,
      pricingModel: data.pricingModel || null,
      retainerAmount: data.retainerAmount ?? null,
      ratePerLead: data.ratePerLead ?? null,
      createdByUserId: managerId
    });

    return toPublicSequence(sequence);
  }

  async list({ managerId, clientId }) {
    const clientWhere = { managerId };
    if (clientId) clientWhere.id = clientId;
    const ownedClientIds = (await Client.findAll({ where: clientWhere, attributes: ['id'] })).map((c) => c.id);
    if (ownedClientIds.length === 0) return [];

    const sequences = await Sequence.findAll({
      where: { clientId: { [Op.in]: ownedClientIds } },
      order: [['createdAt', 'DESC']]
    });

    // Step count per sequence so a manager can see the shape of each motion
    // without opening it.
    return Promise.all(
      sequences.map(async (s) => ({
        ...toPublicSequence(s),
        stepCount: await Campaign.count({ where: { sequenceId: s.id } })
      }))
    );
  }

  /** Full rollup: steps, deduplicated totals, and sequence-level billing. */
  async getById(id, managerId) {
    const sequence = await this._getOwned(id, managerId);
    return sequenceRollup(sequence.id);
  }

  async update(id, managerId, updates) {
    const sequence = await this._getOwned(id, managerId, { requireActive: true });

    const merged = {
      pricingModel: updates.pricingModel !== undefined ? updates.pricingModel : sequence.pricingModel,
      retainerAmount: updates.retainerAmount !== undefined ? updates.retainerAmount : sequence.retainerAmount,
      ratePerLead: updates.ratePerLead !== undefined ? updates.ratePerLead : sequence.ratePerLead
    };
    if (merged.pricingModel === 'flat_retainer' && (merged.retainerAmount == null || merged.ratePerLead != null)) {
      throw new BusinessRuleError('A flat retainer sequence needs retainerAmount and no ratePerLead.');
    }
    if (merged.pricingModel === 'cost_per_lead' && (merged.ratePerLead == null || merged.retainerAmount != null)) {
      throw new BusinessRuleError('A cost-per-lead sequence needs ratePerLead and no retainerAmount.');
    }
    if (!merged.pricingModel && (merged.retainerAmount != null || merged.ratePerLead != null)) {
      throw new BusinessRuleError('Pricing amounts require a pricing model.');
    }

    await sequence.update(updates);
    return toPublicSequence(sequence);
  }

  async _getOwned(id, managerId, { requireActive = false } = {}) {
    const sequence = await Sequence.findByPk(id);
    if (!sequence) throw new NotFoundError('Sequence not found.');
    try {
      await assertClientOwnership(sequence.clientId, managerId, { requireActive });
    } catch (err) {
      if (err instanceof NotFoundError) throw new NotFoundError('Sequence not found.');
      throw err;
    }
    return sequence;
  }
}

module.exports = new SequenceService();
