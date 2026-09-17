'use strict';

const { LeadListMembership, ClientLead, constants } = require('leadpulse-data-model');
const { NotFoundError } = require('../../lib');

const { MEMBERSHIP_STATUS, MEMBERSHIP_STATUS_ORDER } = constants;

/**
 * The single place every membership status transition must go through —
 * whether triggered automatically (an email click, a call outcome) or
 * manually (a Manager override on the lead detail page).
 *
 * Rule: automatic transitions only ever move forward (New -> Contacted ->
 * Qualified -> Converted), or to Dead on an explicit negative signal. They
 * never regress a status that's already further along — e.g. a stray
 * "Not Answered" call attempt on someone already Qualified must not demote
 * them back to Contacted. Manual overrides are exempt from this guard,
 * since a Manager might legitimately need to correct a mistake.
 */
async function updateLeadStatus({ leadListId, leadId, newStatus, isManualOverride = false, transaction }) {
  const membership = await LeadListMembership.findOne({
    where: { leadListId, leadId },
    transaction
  });
  if (!membership) {
    throw new NotFoundError('This lead is not part of that list.');
  }

  if (!isManualOverride) {
    const isDeadTransition = newStatus === MEMBERSHIP_STATUS.DEAD;
    const currentRank = MEMBERSHIP_STATUS_ORDER.indexOf(membership.status);
    const newRank = MEMBERSHIP_STATUS_ORDER.indexOf(newStatus);

    if (!isDeadTransition && newRank <= currentRank) {
      // Silently a no-op — an automatic event trying to move status
      // backward (or sideways) is exactly the case this guard exists for.
      return membership;
    }
  }

  await membership.update({ status: newStatus }, { transaction });
  return membership;
}

/**
 * The "live check" run immediately before actually contacting a lead —
 * about to send an email, about to show a Call Card — never at
 * audience-freeze time. A campaign's frozen campaign_leads snapshot can go
 * stale in two independent ways since approval:
 *
 *   1. The lead reached Converted/Dead via a DIFFERENT, concurrently
 *      running campaign on the same list.
 *   2. The lead's consent changed for this client (asked not to be called,
 *      unsubscribed from email, or hard-bounced).
 *
 * Consent is deliberately channel-specific:
 *   - email blocks on dnc OR isUnsubscribed OR isHardBounced
 *   - call  blocks on dnc ONLY — an email unsubscribe was never a
 *     "don't phone me" signal, and treating it as one would wrongly
 *     shrink call audiences.
 *
 * Returns { contactable, reason } so the caller can record WHY a lead was
 * skipped rather than silently dropping them.
 */
async function checkContactable({ clientId, leadListId, leadId, channel, excludeClosedLeads = true }) {
  const membership = await LeadListMembership.findOne({ where: { leadListId, leadId } });
  if (!membership) return { contactable: false, reason: 'not_in_list' };

  // This block only applies to campaigns that asked to exclude closed leads
  // (the default). A deliberate re-engagement campaign sets
  // excludeClosedLeads: false specifically to target Converted/Dead leads —
  // for that campaign, being Converted/Dead is the intended target, not
  // staleness. Consent checks below stay unconditional regardless: DNC,
  // unsubscribed and hard-bounced are never overridden by re-engagement intent.
  if (excludeClosedLeads) {
    if (membership.status === MEMBERSHIP_STATUS.CONVERTED) {
      return { contactable: false, reason: 'already_converted' };
    }
    if (membership.status === MEMBERSHIP_STATUS.DEAD) {
      return { contactable: false, reason: 'marked_dead' };
    }
  }

  const clientLead = await ClientLead.findOne({ where: { clientId, leadId } });
  if (!clientLead) return { contactable: false, reason: 'not_mapped_to_client' };

  if (clientLead.dnc) return { contactable: false, reason: 'dnc' };

  if (channel === 'email') {
    if (clientLead.isUnsubscribed) return { contactable: false, reason: 'unsubscribed' };
    if (clientLead.isHardBounced) return { contactable: false, reason: 'hard_bounced' };
  }

  return { contactable: true, reason: null };
}

module.exports = { updateLeadStatus, checkContactable };
