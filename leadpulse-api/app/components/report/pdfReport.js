'use strict';

const PDFDocument = require('pdfkit');
const { constants } = require('leadpulse-data-model');

const { CAMPAIGN_TYPE } = constants;

const BRAND = '#1a56db';
const MUTED = '#666666';
const LINE = '#dddddd';

const fmtDate = (d) =>
  d ? new Date(d).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) : '—';

const fmtMoney = (n) => (n == null ? '—' : `${Number(n).toFixed(2)}`);

/**
 * Builds the campaign PDF and resolves to a Buffer.
 *
 * Uses pdfkit rather than the SRS's suggested Puppeteer: the report is a
 * cover page, KPI blocks and tables, none of which needs HTML/CSS
 * rendering. Puppeteer would pull a ~300MB Chromium and a dozen system
 * libraries into the container for no gain — a deliberate trade of exact
 * SRS wording for a deployable image.
 */
function generateCampaignPdf(report) {
  return new Promise((resolve, reject) => {
    const { summary, metrics, billing, observations, campaign } = report;
    const doc = new PDFDocument({ size: 'A4', margin: 50 });
    const chunks = [];

    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const line = () => {
      doc.moveDown(0.4);
      doc.strokeColor(LINE).lineWidth(1).moveTo(50, doc.y).lineTo(545, doc.y).stroke();
      doc.moveDown(0.6);
    };

    const heading = (text) => {
      doc.moveDown(0.8).fillColor(BRAND).fontSize(14).text(text);
      doc.moveDown(0.3).fillColor('#000');
    };

    const kv = (label, value) => {
      doc.fontSize(10).fillColor(MUTED).text(label, { continued: true });
      doc.fillColor('#000').text(`   ${value}`);
    };

    // --- Cover -----------------------------------------------------------
    doc.fillColor(BRAND).fontSize(26).text('LeadPulse');
    doc.fillColor(MUTED).fontSize(11).text('Campaign Report');
    line();

    doc.fillColor('#000').fontSize(20).text(summary.name);
    doc.moveDown(0.5);
    kv('Client', summary.clientName);
    kv('Type', summary.type === CAMPAIGN_TYPE.EMAIL ? 'Email campaign' : 'Call campaign');
    kv('Status', summary.status);
    kv('Audience', `${summary.audience} leads`);
    kv('Created', fmtDate(summary.createdAt));
    kv('Activated', fmtDate(summary.approvedAt));
    kv('Report generated', fmtDate(summary.generatedAt));
    line();

    // --- Executive summary ------------------------------------------------
    heading('Executive summary');

    if (summary.type === CAMPAIGN_TYPE.EMAIL) {
      kv('Emails sent', metrics.sent);
      kv('Delivered', metrics.delivered);
      kv('Opened', `${metrics.opened}  (${metrics.rates.openRate}%)`);
      kv('Clicked', `${metrics.clicked}  (${metrics.rates.clickThroughRate}%)`);
      kv('Converted', metrics.converted);
      kv('Bounced', `${metrics.bounced}  (${metrics.rates.bounceRate}%)`);
      kv('Unsubscribed', `${metrics.unsubscribed}  (${metrics.rates.unsubscribeRate}%)`);

      heading('Engagement funnel');
      const steps = [
        ['Audience', metrics.audience],
        ['Sent', metrics.sent],
        ['Delivered', metrics.delivered],
        ['Opened', metrics.opened],
        ['Clicked', metrics.clicked],
        ['Converted', metrics.converted]
      ];
      steps.forEach(([label, value]) => {
        const width = metrics.audience > 0 ? Math.max(2, Math.round((value / metrics.audience) * 300)) : 2;
        doc.fontSize(9).fillColor('#000').text(`${label} (${value})`, 50, doc.y, { width: 130, continued: false });
        doc.rect(190, doc.y - 11, width, 9).fill(BRAND);
        doc.fillColor('#000');
        doc.moveDown(0.35);
      });
    } else {
      kv('Leads in queue', metrics.queue.total);
      kv('Calls logged', metrics.totalCalls);
      kv('Leads called', metrics.funnel.called);
      kv('Reached (answered)', metrics.funnel.reached);
      kv('Confirmed conversions', metrics.funnel.converted);
      kv('Average call duration', metrics.averageDurationMinutes != null ? `${metrics.averageDurationMinutes} min` : '—');

      heading('Call outcomes');
      Object.entries(metrics.outcomes)
        .filter(([, count]) => count > 0)
        .forEach(([outcome, count]) => {
          const width = metrics.totalCalls > 0 ? Math.max(2, Math.round((count / metrics.totalCalls) * 280)) : 2;
          doc.fontSize(9).fillColor('#000').text(`${outcome} (${count})`, 50, doc.y, { width: 150 });
          doc.rect(210, doc.y - 11, width, 9).fill(BRAND);
          doc.fillColor('#000');
          doc.moveDown(0.35);
        });

      if (metrics.executives.length) {
        heading('Executive performance');
        doc.fontSize(9).fillColor(MUTED);
        doc.text('Executive', 50, doc.y, { width: 160, continued: true });
        doc.text('Calls', { width: 60, continued: true });
        doc.text('Avg min', { width: 70, continued: true });
        doc.text('Claimed', { width: 70, continued: true });
        doc.text('Confirmed');
        doc.moveDown(0.2);
        doc.fillColor('#000');
        metrics.executives.forEach((e) => {
          doc.text(e.name, 50, doc.y, { width: 160, continued: true });
          doc.text(String(e.callsLogged), { width: 60, continued: true });
          doc.text(e.averageDurationMinutes != null ? String(e.averageDurationMinutes) : '—', { width: 70, continued: true });
          doc.text(String(e.conversionsClaimed), { width: 70, continued: true });
          doc.text(String(e.conversionsConfirmed));
          doc.moveDown(0.15);
        });
      }
    }

    // --- Billing ----------------------------------------------------------
    if (billing) {
      heading('Commercials');
      if (billing.pricingModel === 'cost_per_lead') {
        kv('Pricing model', 'Cost per lead');
        kv('Agreed rate', `${fmtMoney(billing.ratePerLead)} per confirmed lead`);
        kv('Confirmed conversions', billing.confirmedConversions);
        kv('Amount accrued', fmtMoney(billing.amountAccrued));
      } else {
        kv('Pricing model', 'Flat retainer');
        kv('Retainer', fmtMoney(billing.retainerAmount));
        kv('Confirmed conversions', billing.confirmedConversions);
        kv('Cost per conversion', fmtMoney(billing.costPerConversion));
      }
      doc.moveDown(0.3);
      doc.fontSize(8).fillColor(MUTED).text(
        'Only conversions confirmed by a manager are counted. Claimed but unreviewed conversions are excluded.'
      );
      doc.fillColor('#000');
    }

    // --- Observations -----------------------------------------------------
    heading('Observations');
    observations.forEach((note) => {
      doc.fontSize(10).fillColor('#000').text(`•  ${note}`, { width: 495 });
      doc.moveDown(0.2);
    });

    doc.moveDown(1.5);
    doc.fontSize(8).fillColor(MUTED).text(
      `Generated by LeadPulse on ${fmtDate(summary.generatedAt)} — campaign ${campaign.id}`,
      { align: 'center' }
    );

    doc.end();
  });
}

module.exports = { generateCampaignPdf };
