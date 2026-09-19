'use strict';

/**
 * Renders a campaign's HTML body for one specific lead: substitutes merge
 * variables, rewrites outbound links through the click tracker, appends the
 * open pixel, and guarantees an unsubscribe link is present.
 *
 * Kept as plain string work rather than pulling in a template engine — the
 * SRS's merge variables are a fixed, small set, and a regex replace is
 * easier to reason about (and to prove correct) than a templating
 * dependency for this.
 */

const escapeHtml = (value) =>
  String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

/**
 * Merge variables, per SRS 4.5.1. Every substituted value is HTML-escaped:
 * lead data is externally sourced (uploaded CSVs), so a company name
 * containing markup must never be able to inject into the email body.
 */
function applyMergeVariables(html, { lead, campaignName, unsubscribeUrl }) {
  const values = {
    first_name: escapeHtml(lead.firstName),
    last_name: escapeHtml(lead.lastName),
    company: escapeHtml(lead.company),
    job_title: escapeHtml(lead.jobTitle),
    campaign_name: escapeHtml(campaignName),
    // Deliberately NOT escaped as text — this is a URL we generated
    // ourselves, inserted as a full anchor tag.
    unsubscribe_link: `<a href="${unsubscribeUrl}">Unsubscribe</a>`
  };

  return html.replace(/\{\{\s*(\w+)\s*\}\}/g, (match, key) =>
    Object.prototype.hasOwnProperty.call(values, key) ? values[key] : match
  );
}

/**
 * Rewrites every http(s) href through the click-tracking redirect so opens
 * and clicks can be attributed. The tracking and unsubscribe links we just
 * injected are skipped — rewriting those would double-wrap them.
 */
function rewriteLinksForTracking(html, { trackingBaseUrl, token }) {
  return html.replace(/href="(https?:\/\/[^"]+)"/gi, (match, url) => {
    if (url.startsWith(`${trackingBaseUrl}/track/`)) return match;
    return `href="${trackingBaseUrl}/track/click?token=${token}&url=${encodeURIComponent(url)}"`;
  });
}

function buildEmailHtml({ campaign, lead, token, trackingBaseUrl }) {
  const unsubscribeUrl = `${trackingBaseUrl}/track/unsubscribe?token=${token}`;

  let html = applyMergeVariables(campaign.emailBodyHtml || '', {
    lead,
    campaignName: campaign.name,
    unsubscribeUrl
  });

  if (campaign.bannerImageUrl) {
    html = `<img src="${campaign.bannerImageUrl}" alt="" style="max-width:100%;" /><br/>${html}`;
  }

  html = rewriteLinksForTracking(html, { trackingBaseUrl, token });

  // SRS 4.5.1: the unsubscribe link is auto-injected if the author didn't
  // include one. Checked AFTER merge substitution so a {{unsubscribe_link}}
  // placeholder counts as already present.
  if (!html.includes('/track/unsubscribe')) {
    html += `<hr/><p style="font-size:12px;color:#666;">
      Don't want these emails? <a href="${unsubscribeUrl}">Unsubscribe</a>.
    </p>`;
  }

  // Open tracking pixel, last so it doesn't interfere with link rewriting.
  html += `<img src="${trackingBaseUrl}/track/open?token=${token}" width="1" height="1" alt="" style="display:none;" />`;

  return html;
}

function buildSubject(campaign, lead) {
  return applyMergeVariables(campaign.subjectLine || '', {
    lead,
    campaignName: campaign.name,
    unsubscribeUrl: ''
  });
}

module.exports = { buildEmailHtml, buildSubject, applyMergeVariables };
