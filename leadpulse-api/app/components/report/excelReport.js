'use strict';

const ExcelJS = require('exceljs');
const { constants } = require('leadpulse-data-model');

const { CAMPAIGN_TYPE } = constants;

const HEADER_FILL = 'FF1A56DB';
const ALT_FILL = 'FFF3F6FC';

function styleHeader(sheet) {
  const header = sheet.getRow(1);
  header.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  header.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: HEADER_FILL } };
  header.alignment = { vertical: 'middle' };
  header.height = 20;
}

function stripeRows(sheet) {
  sheet.eachRow((row, n) => {
    if (n > 1 && n % 2 === 0) {
      row.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: ALT_FILL } };
    }
  });
}

function autoSize(sheet) {
  sheet.columns.forEach((col) => {
    let longest = col.header ? String(col.header).length : 10;
    col.eachCell({ includeEmpty: false }, (cell) => {
      const len = cell.value == null ? 0 : String(cell.value).length;
      if (len > longest) longest = len;
    });
    // Capped: a free-text notes column would otherwise blow the sheet out
    // to hundreds of characters wide.
    col.width = Math.min(Math.max(longest + 2, 10), 45);
  });
}

/**
 * Builds the campaign workbook and resolves to a Buffer.
 *
 * Sheet 1 is lead-level detail (engagement for email, remarks for call);
 * Sheet 2 is the campaign summary. Rows arrive already redacted for the
 * viewer by reportData.leadRows, so this file never has to know about
 * client visibility rules.
 */
async function generateCampaignExcel(report, leadRows) {
  const { summary, metrics, billing, observations } = report;
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'LeadPulse';
  workbook.created = new Date();

  const isEmail = summary.type === CAMPAIGN_TYPE.EMAIL;

  // --- Sheet 1: lead-level detail ---------------------------------------
  const detail = workbook.addWorksheet(isEmail ? 'Lead Engagement' : 'Call Remarks');

  detail.columns = isEmail
    ? [
        { header: 'First Name', key: 'firstName' },
        { header: 'Last Name', key: 'lastName' },
        { header: 'Email', key: 'email' },
        { header: 'Company', key: 'company' },
        { header: 'Job Title', key: 'jobTitle' },
        { header: 'Lead Status', key: 'status' },
        { header: 'Sent At', key: 'sentAt' },
        { header: 'Opened At', key: 'openedAt' },
        { header: 'Opens', key: 'openCount' },
        { header: 'Clicked At', key: 'clickedAt' },
        { header: 'Clicks', key: 'clickCount' },
        { header: 'Converted At', key: 'convertedAt' },
        { header: 'Unsubscribed At', key: 'unsubscribedAt' },
        { header: 'Bounce Type', key: 'bounceType' }
      ]
    : [
        { header: 'First Name', key: 'firstName' },
        { header: 'Last Name', key: 'lastName' },
        { header: 'Phone', key: 'phone' },
        { header: 'Company', key: 'company' },
        { header: 'Job Title', key: 'jobTitle' },
        { header: 'Lead Status', key: 'status' },
        { header: 'Queue Status', key: 'queueStatus' },
        { header: 'Call Outcome', key: 'callOutcome' },
        { header: 'Duration (min)', key: 'callDurationMinutes' },
        { header: 'Notes', key: 'notes' },
        { header: 'Follow-Up Date', key: 'followUpDate' },
        { header: 'Executive', key: 'executiveName' },
        { header: 'Conversion Confirmed', key: 'conversionConfirmed' },
        { header: 'Logged At', key: 'loggedAt' }
      ];

  leadRows.forEach((row) => {
    detail.addRow({
      ...row,
      // Booleans and dates render as readable text rather than raw values,
      // since this workbook is read by people, not re-imported.
      conversionConfirmed:
        row.conversionConfirmed === true ? 'Yes' : row.conversionConfirmed === false ? 'Rejected' : 'Pending',
      sentAt: row.sentAt ? new Date(row.sentAt).toISOString() : '',
      openedAt: row.openedAt ? new Date(row.openedAt).toISOString() : '',
      clickedAt: row.clickedAt ? new Date(row.clickedAt).toISOString() : '',
      convertedAt: row.convertedAt ? new Date(row.convertedAt).toISOString() : '',
      unsubscribedAt: row.unsubscribedAt ? new Date(row.unsubscribedAt).toISOString() : '',
      loggedAt: row.loggedAt ? new Date(row.loggedAt).toISOString() : ''
    });
  });

  styleHeader(detail);
  stripeRows(detail);
  autoSize(detail);
  detail.views = [{ state: 'frozen', ySplit: 1 }];

  // --- Sheet 2: campaign summary ----------------------------------------
  const overview = workbook.addWorksheet('Campaign Summary');
  overview.columns = [
    { header: 'Metric', key: 'metric', width: 32 },
    { header: 'Value', key: 'value', width: 40 }
  ];

  const add = (metric, value) => overview.addRow({ metric, value: value == null ? '—' : value });

  add('Campaign', summary.name);
  add('Client', summary.clientName);
  add('Type', isEmail ? 'Email campaign' : 'Call campaign');
  add('Status', summary.status);
  add('Audience', summary.audience);
  add('Created', summary.createdAt ? new Date(summary.createdAt).toISOString() : '—');
  add('Activated', summary.approvedAt ? new Date(summary.approvedAt).toISOString() : '—');
  add('Report generated', new Date(summary.generatedAt).toISOString());
  add('', '');

  if (isEmail) {
    add('Emails sent', metrics.sent);
    add('Delivered', metrics.delivered);
    add('Opened', metrics.opened);
    add('Clicked', metrics.clicked);
    add('Converted', metrics.converted);
    add('Bounced', metrics.bounced);
    add('Unsubscribed', metrics.unsubscribed);
    add('', '');
    add('Delivery rate (%)', metrics.rates.deliveryRate);
    add('Open rate (%)', metrics.rates.openRate);
    add('Click-through rate (%)', metrics.rates.clickThroughRate);
    add('Click-to-open rate (%)', metrics.rates.clickToOpenRate);
    add('Bounce rate (%)', metrics.rates.bounceRate);
    add('Unsubscribe rate (%)', metrics.rates.unsubscribeRate);
  } else {
    add('Leads in queue', metrics.queue.total);
    add('Calls logged', metrics.totalCalls);
    add('Leads called', metrics.funnel.called);
    add('Reached (answered)', metrics.funnel.reached);
    add('Confirmed conversions', metrics.funnel.converted);
    add('Average duration (min)', metrics.averageDurationMinutes);
    add('', '');
    Object.entries(metrics.outcomes)
      .filter(([, count]) => count > 0)
      .forEach(([outcome, count]) => add(`Outcome — ${outcome}`, count));
  }

  if (billing) {
    add('', '');
    add('Pricing model', billing.pricingModel === 'cost_per_lead' ? 'Cost per lead' : 'Flat retainer');
    if (billing.pricingModel === 'cost_per_lead') {
      add('Agreed rate per lead', billing.ratePerLead);
      add('Confirmed conversions', billing.confirmedConversions);
      add('Amount accrued', billing.amountAccrued);
    } else {
      add('Retainer amount', billing.retainerAmount);
      add('Confirmed conversions', billing.confirmedConversions);
      add('Cost per conversion', billing.costPerConversion);
    }
  }

  add('', '');
  observations.forEach((note, i) => add(i === 0 ? 'Observations' : '', note));

  styleHeader(overview);

  return workbook.xlsx.writeBuffer();
}

module.exports = { generateCampaignExcel };
