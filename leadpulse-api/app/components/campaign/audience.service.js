'use strict';

const { Lead, ClientLead, LeadListMembership, LeadList, Sequelize } = require('leadpulse-data-model');
const { NotFoundError } = require('../../lib');

const { Op } = Sequelize;

const CLOSED_STATUSES = ['Converted', 'Dead'];

/**
 * Resolves a campaign's target audience at freeze time — the list of lead
 * IDs that will be written into campaign_leads at approval. This runs ONCE,
 * at approval; the campaign never re-runs it afterward, which is what makes
 * the audience a frozen snapshot rather than a live query.
 *
 * The pipeline, in order:
 *   1. Start from the campaign's source lead list (its memberships).
 *   2. Drop Converted/Dead unless excludeClosedLeads is off.
 *   3. Apply membershipStatus filter (this is what sequence steps use).
 *   4. Apply lead-level filters (industry / jobTitle / source).
 *   5. Keep only leads mapped to this client (they always are, but this is
 *      the tenant-safety belt).
 *
 * Consent (dnc/unsubscribed/bounced) is deliberately NOT filtered here —
 * that's checked live at actual contact time, not frozen, so a consent
 * change after approval still takes effect. Freeze-time only handles
 * targeting criteria.
 */
async function resolveAudienceLeadIds(campaign) {
  const list = await LeadList.findByPk(campaign.leadListId);
  if (!list) throw new NotFoundError('Campaign source lead list not found.');

  const filters = campaign.segmentationFilters || {};

  // Step 1-3: membership-level filtering on the source list.
  //
  // Note these are applied together, not as alternatives: a membershipStatus
  // filter narrows to one status, and excludeClosedLeads independently drops
  // Converted/Dead. A campaign that genuinely wants to re-engage closed
  // leads must set excludeClosedLeads to false — that contradiction is
  // rejected at creation time rather than silently resolved here.
  const membershipWhere = { leadListId: campaign.leadListId };
  if (filters.membershipStatus) {
    membershipWhere.status = filters.membershipStatus;
  }
  if (campaign.excludeClosedLeads) {
    membershipWhere.status = membershipWhere.status
      ? { [Op.and]: [membershipWhere.status, { [Op.notIn]: CLOSED_STATUSES }] }
      : { [Op.notIn]: CLOSED_STATUSES };
  }

  const memberships = await LeadListMembership.findAll({
    where: membershipWhere,
    attributes: ['leadId']
  });
  let leadIds = memberships.map((m) => m.leadId);
  if (leadIds.length === 0) return [];

  // Step 4: lead-level firmographic filters, if any.
  const leadWhere = { id: { [Op.in]: leadIds } };
  if (filters.industry) leadWhere.industry = { [Op.iLike]: `%${filters.industry}%` };
  if (filters.jobTitle) leadWhere.jobTitle = { [Op.iLike]: `%${filters.jobTitle}%` };
  if (filters.source) leadWhere.source = { [Op.iLike]: `%${filters.source}%` };

  if (filters.industry || filters.jobTitle || filters.source) {
    const leads = await Lead.findAll({ where: leadWhere, attributes: ['id'] });
    leadIds = leads.map((l) => l.id);
    if (leadIds.length === 0) return [];
  }

  // Step 5: tenant safety — only leads actually mapped to this client.
  const clientLeads = await ClientLead.findAll({
    where: { clientId: campaign.clientId, leadId: { [Op.in]: leadIds } },
    attributes: ['leadId']
  });
  return clientLeads.map((cl) => cl.leadId);
}

module.exports = { resolveAudienceLeadIds };
