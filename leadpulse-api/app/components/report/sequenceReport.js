'use strict';

const PDFDocument = require('pdfkit');
const ExcelJS = require('exceljs');

const BRAND = '#1a56db';
const MUTED = '#666666';
const LINE = '#dddddd';
const HEADER_FILL = 'FF1A56DB';
const ALT_FILL = 'FFF3F6FC';

const fmtDate = (d) =>
  d ? new Date(d).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) : '—';
const fmtMoney = (n) => (n == null ? '—' : `${Number(n).toFixed(2)}`);

/**
 * The sequence report is the CLIENT-FACING commercial document: a client
 * contracted for an outreach motion, so this reports the motion as a whole —
 * one set of deduplicated totals and one amount owed — with the individual
 * steps shown underneath as the breakdown of how the work was done.
 *
 * Deliberately contains no lead identities at all. Per-lead detail lives in
 * the per-campaign reports, which apply their own Qualified/Converted
 * redaction; a sequence report is a summary artifact, so there is nothing
 * here to redact and no way for it to leak a contact.
 */
function generateSequencePdf(rollup) {
  return new Promise((resolve, reject) => {
    const { sequence, steps, totals, conversionsByStep, billing } = rollup;
    const doc = new PDFDocument({ size: 'A4', margin: 50 });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    // --- Cover -----------------------------------------------------------
    doc.fillColor(BRAND).fontSize(24).text('Campaign Report', { align: 'left' });
    doc.moveDown(0.3);
    doc.fillColor('#000').fontSize(18).text(sequence.name);
    if (sequence.description) {
      doc.moveDown(0.2);
      doc.fillColor(MUTED).fontSize(11).text(sequence.description);
    }
    doc.moveDown(0.8);

    const kv = (label, value) => {
      doc.fillColor(MUTED).fontSize(10).text(label, { continued: true });
      doc.fillColor('#000').fontSize(10).text(`   ${value}`);
    };
    kv('Client', rollup.clientName || '—');
    kv('Steps in this campaign', String(totals.steps));
    kv('Started', fmtDate(sequence.createdAt));
    kv('Report generated', fmtDate(new Date()));

    doc.moveDown(1);
    doc.strokeColor(LINE).moveTo(50, doc.y).lineTo(545, doc.y).stroke();
    doc.moveDown(1);

    // --- Headline results -------------------------------------------------
    doc.fillColor(BRAND).fontSize(14).text('Results');
    doc.moveDown(0.5);
    // Unique people, not touch-count: someone contacted at three steps is one
    // person reached. Counting rows here is what previously made totals
    // exceed the size of the source list.
    kv('Unique leads reached', String(totals.uniqueLeadsReached));
    kv('Emails sent', String(totals.emailsSent));
    kv('Calls logged', String(totals.callsLogged));
    kv('Leads converted', String(totals.convertedLeads));

    doc.moveDown(1);

    // --- Billing ----------------------------------------------------------
    if (billing) {
      doc.fillColor(BRAND).fontSize(14).text('Billing');
      doc.moveDown(0.5);
      if (billing.pricingModel === 'cost_per_lead') {
        kv('Pricing model', 'Cost per converted lead');
        kv('Agreed rate', `${fmtMoney(billing.ratePerLead)} per converted lead`);
        kv('Billable conversions', String(billing.billableConversions));
        doc.moveDown(0.3);
        doc.fillColor('#000').fontSize(12).text(`Amount accrued: ${fmtMoney(billing.amountAccrued)}`, { underline: false });
        doc.moveDown(0.2);
        doc
          .fillColor(MUTED)
          .fontSize(9)
          .text(
            'Each lead is charged once for this campaign, however many steps reached them. A lead contacted again in a later step is never billed twice.'
          );
      } else if (billing.pricingModel === 'flat_retainer') {
        kv('Pricing model', 'Flat retainer');
        kv('Retainer', fmtMoney(billing.retainerAmount));
        kv('Leads converted', String(billing.billableConversions));
        kv('Effective cost per conversion', fmtMoney(billing.costPerConversion));
      }
      doc.moveDown(1);
    }

    // --- Step breakdown ---------------------------------------------------
    doc.fillColor(BRAND).fontSize(14).text('How the campaign ran');
    doc.moveDown(0.5);

    const colX = [50, 240, 320, 400, 480];
    doc.fillColor(MUTED).fontSize(9);
    doc.text('Step', colX[0], doc.y, { continued: false });
    const headerY = doc.y - 11;
    doc.text('Name', colX[1], headerY);
    doc.text('Channel', colX[2], headerY);
    doc.text('Status', colX[3], headerY);
    doc.text('Converted', colX[4], headerY);
    doc.moveDown(0.3);
    doc.strokeColor(LINE).moveTo(50, doc.y).lineTo(545, doc.y).stroke();
    doc.moveDown(0.4);

    steps.forEach((step) => {
      const conv = conversionsByStep.find((c) => c.campaignName === step.name);
      const y = doc.y;
      doc.fillColor('#000').fontSize(9);
      doc.text(step.stepOrder == null ? '—' : String(step.stepOrder), colX[0], y);
      doc.text(String(step.name).slice(0, 30), colX[1], y);
      doc.text(step.type, colX[2], y);
      doc.text(step.status, colX[3], y);
      doc.text(String(conv ? conv.conversions : 0), colX[4], y);
      doc.moveDown(0.6);
    });

    if (steps.length === 0) {
      doc.fillColor(MUTED).fontSize(10).text('No steps have been run for this campaign yet.');
    }

    doc.moveDown(1);
    doc
      .fillColor(MUTED)
      .fontSize(8)
      .text(
        'Conversions are attributed to the step at which the lead first converted. Totals are deduplicated: a lead reached by several steps is counted once.',
        50,
        doc.y,
        { width: 495 }
      );

    doc.end();
  });
}

async function generateSequenceExcel(rollup) {
  const { sequence, steps, totals, conversionsByStep, billing } = rollup;
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'LeadPulse';
  workbook.created = new Date();

  const style = (sheet) => {
    const header = sheet.getRow(1);
    header.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    header.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: HEADER_FILL } };
    header.height = 20;
    sheet.eachRow((row, n) => {
      if (n > 1 && n % 2 === 0) {
        row.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: ALT_FILL } };
      }
    });
    sheet.columns.forEach((col) => {
      let longest = col.header ? String(col.header).length : 10;
      col.eachCell({ includeEmpty: false }, (cell) => {
        const len = cell.value == null ? 0 : String(cell.value).length;
        if (len > longest) longest = len;
      });
      col.width = Math.min(Math.max(longest + 2, 12), 45);
    });
  };

  // --- Sheet 1: the steps -----------------------------------------------
  const stepSheet = workbook.addWorksheet('Campaign Steps');
  stepSheet.columns = [
    { header: 'Step', key: 'stepOrder' },
    { header: 'Name', key: 'name' },
    { header: 'Channel', key: 'type' },
    { header: 'Status', key: 'status' },
    { header: 'Conversions at this step', key: 'conversions' }
  ];
  steps.forEach((s) => {
    const conv = conversionsByStep.find((c) => c.campaignName === s.name);
    stepSheet.addRow({
      stepOrder: s.stepOrder == null ? '—' : s.stepOrder,
      name: s.name,
      type: s.type,
      status: s.status,
      conversions: conv ? conv.conversions : 0
    });
  });
  style(stepSheet);

  // --- Sheet 2: summary + billing ---------------------------------------
  const summary = workbook.addWorksheet('Summary');
  summary.columns = [
    { header: 'Metric', key: 'metric' },
    { header: 'Value', key: 'value' }
  ];
  const add = (metric, value) => summary.addRow({ metric, value: value == null ? '—' : value });

  add('Campaign', sequence.name);
  if (sequence.description) add('Description', sequence.description);
  add('Client', rollup.clientName || '—');
  add('Steps', totals.steps);
  add('Started', fmtDate(sequence.createdAt));
  add('Report generated', fmtDate(new Date()));
  add('', '');
  add('Unique leads reached', totals.uniqueLeadsReached);
  add('Emails sent', totals.emailsSent);
  add('Calls logged', totals.callsLogged);
  add('Leads converted', totals.convertedLeads);

  if (billing) {
    add('', '');
    if (billing.pricingModel === 'cost_per_lead') {
      add('Pricing model', 'Cost per converted lead');
      add('Agreed rate per lead', billing.ratePerLead);
      add('Billable conversions', billing.billableConversions);
      add('Amount accrued', billing.amountAccrued);
      add('Note', 'Each lead is billed once per campaign, however many steps reached them.');
    } else if (billing.pricingModel === 'flat_retainer') {
      add('Pricing model', 'Flat retainer');
      add('Retainer amount', billing.retainerAmount);
      add('Leads converted', billing.billableConversions);
      add('Effective cost per conversion', billing.costPerConversion);
    }
  }
  style(summary);

  return workbook.xlsx.writeBuffer();
}

module.exports = { generateSequencePdf, generateSequenceExcel };
