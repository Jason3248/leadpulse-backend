'use strict';

const { Lead, ClientLead, LeadList, LeadListMembership, Sequelize } = require('leadpulse-data-model');
const { NotFoundError, ValidationError } = require('../../lib');
const { updateLeadStatus } = require('./leadStatus.service.js');
const assertClientOwnership = require('../client/assertClientOwnership.js');

const { Op } = Sequelize;

// clientLead is the requesting Client's own mapping row (never someone
// else's) — its consent flags and memberships are safe to expose alongside
// the global identity fields. What's NEVER included here is any hint that
// this lead belongs to any other Client (the ethical-firewall decision).
const toPublicLead = (lead, clientLead, memberships) => ({
  id: lead.id,
  firstName: lead.firstName,
  lastName: lead.lastName,
  email: lead.email,
  phone: lead.phone,
  company: lead.company,
  jobTitle: lead.jobTitle,
  industry: lead.industry,
  source: lead.source,
  createdAt: lead.createdAt,
  ...(clientLead
    ? {
        dnc: clientLead.dnc,
        isUnsubscribed: clientLead.isUnsubscribed,
        isHardBounced: clientLead.isHardBounced
      }
    : {}),
  ...(memberships
    ? {
        memberships: memberships.map((m) => ({
          leadListId: m.leadListId,
          leadListName: m.leadList ? m.leadList.name : undefined,
          status: m.status
        }))
      }
    : {})
});

class LeadService {
  async list({ clientId, managerId, leadListId, industry, jobTitle, source, status, page = 1, pageSize = 25 }) {
    if (!clientId) throw new ValidationError('clientId query parameter is required.');
    const safePage = Math.max(1, parseInt(page, 10) || 1);
    const safePageSize = Math.min(100, Math.max(1, parseInt(pageSize, 10) || 25));

    // Reading is always allowed, even for a deactivated client — a Manager
    // needs to review historical data regardless of current status.
    await assertClientOwnership(clientId, managerId, { requireActive: false });

    // Scope to this Client first: which leads is this Client even allowed
    // to see. This is the tenant boundary now that leads are shared.
    const clientLeadRows = await ClientLead.findAll({ where: { clientId } });
    const clientLeadByLeadId = new Map(clientLeadRows.map((cl) => [cl.leadId, cl]));
    let scopedLeadIds = [...clientLeadByLeadId.keys()];

    if (scopedLeadIds.length === 0) {
      return { leads: [], pagination: { page: safePage, pageSize: safePageSize, total: 0, totalPages: 0 } };
    }

    if (leadListId || status) {
      const membershipWhere = {};
      if (leadListId) membershipWhere.leadListId = leadListId;
      if (status) membershipWhere.status = status;
      const matches = await LeadListMembership.findAll({ where: membershipWhere, attributes: ['leadId'] });
      const matchingIds = new Set(matches.map((m) => m.leadId));
      scopedLeadIds = scopedLeadIds.filter((id) => matchingIds.has(id));
    }

    const where = { id: { [Op.in]: scopedLeadIds.length ? scopedLeadIds : [null] } };
    if (industry) where.industry = { [Op.iLike]: `%${industry}%` };
    if (jobTitle) where.jobTitle = { [Op.iLike]: `%${jobTitle}%` };
    if (source) where.source = { [Op.iLike]: `%${source}%` };

    const { rows, count } = await Lead.findAndCountAll({
      where,
      limit: safePageSize,
      offset: (safePage - 1) * safePageSize,
      order: [['createdAt', 'DESC']]
    });

    const leadIds = rows.map((r) => r.id);
    const memberships = leadIds.length
      ? await LeadListMembership.findAll({
          where: { leadId: { [Op.in]: leadIds } },
          include: [{ model: LeadList, as: 'leadList', attributes: ['id', 'name'] }]
        })
      : [];
    const membershipsByLeadId = memberships.reduce((acc, m) => {
      (acc[m.leadId] = acc[m.leadId] || []).push(m);
      return acc;
    }, {});

    const leads = rows.map((lead) =>
      toPublicLead(lead, clientLeadByLeadId.get(lead.id), membershipsByLeadId[lead.id] || [])
    );

    return {
      leads,
      pagination: { page: safePage, pageSize: safePageSize, total: count, totalPages: Math.ceil(count / safePageSize) }
    };
  }

  async getById(id, managerId, clientId) {
    if (!clientId) throw new ValidationError('clientId query parameter is required.');
    await assertClientOwnership(clientId, managerId, { requireActive: false });

    const clientLead = await ClientLead.findOne({ where: { clientId, leadId: id } });
    if (!clientLead) throw new NotFoundError('Lead not found for this client.');

    const lead = await Lead.findByPk(id);
    if (!lead) throw new NotFoundError('Lead not found for this client.');

    // Memberships are scoped to lists belonging to THIS client only — a
    // Manager viewing this lead in Beta Inc's context never sees Acme
    // Corp's lists for the same person, even if both are their own clients.
    const clientListIds = (await LeadList.findAll({ where: { clientId }, attributes: ['id'] })).map((l) => l.id);
    const memberships = await LeadListMembership.findAll({
      where: { leadId: id, leadListId: { [Op.in]: clientListIds.length ? clientListIds : [null] } },
      include: [{ model: LeadList, as: 'leadList', attributes: ['id', 'name'] }]
    });

    return toPublicLead(lead, clientLead, memberships);
  }

  async setDnc(id, managerId, clientId, dnc) {
    // Consent changes are real business activity — blocked for a
    // deactivated client, same as importing.
    const clientLead = await this._getOwnedClientLead(id, managerId, clientId, { requireActive: true });
    await clientLead.update({ dnc });
    const lead = await Lead.findByPk(id);
    return toPublicLead(lead, clientLead);
  }

  async updateStatus(id, managerId, { leadListId, status }) {
    const list = await LeadList.findByPk(leadListId);
    if (!list) throw new NotFoundError('Lead list not found.');
    await this._getOwnedClientLead(id, managerId, list.clientId, { requireActive: true });

    // Manual overrides bypass the forward-only guard — a Manager correcting
    // a mistake is allowed to move status in any direction.
    const membership = await updateLeadStatus({ leadListId, leadId: id, newStatus: status, isManualOverride: true });
    return { leadListId: membership.leadListId, leadId: membership.leadId, status: membership.status };
  }

  async _getOwnedClientLead(leadId, managerId, clientId, { requireActive = false } = {}) {
    await assertClientOwnership(clientId, managerId, { requireActive });
    const clientLead = await ClientLead.findOne({ where: { clientId, leadId } });
    if (!clientLead) throw new NotFoundError('Lead not found for this client.');
    return clientLead;
  }
}

module.exports = new LeadService();
