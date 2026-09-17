'use strict';

const reportData = require('./reportData.service.js');
const { generateCampaignPdf } = require('./pdfReport.js');
const { generateCampaignExcel } = require('./excelReport.js');
const { generateSequencePdf, generateSequenceExcel } = require('./sequenceReport.js');
const { sequenceRollup } = require('../sequence/sequenceBilling.service.js');
const { Sequence, Client } = require('leadpulse-data-model');
const { NotFoundError } = require('../../lib');
const assertClientOwnership = require('../client/assertClientOwnership.js');
const asyncHandler = require('../../utils/asyncHandler.js');

// Filenames follow SRS 4.9: <CampaignName>_Report_<YYYYMMDD>.pdf
const stamp = () => new Date().toISOString().slice(0, 10).replace(/-/g, '');
const safeName = (name) => String(name).replace(/[^a-z0-9]+/gi, '_').replace(/^_+|_+$/g, '').slice(0, 60) || 'Campaign';

class ReportController {
  /**
   * Both report endpoints are generated on demand and streamed straight to
   * the caller — nothing is persisted. We decided against a reports table
   * early on: a report is fully derivable from live data, so storing one
   * only creates a second copy that can go stale.
   */

  campaignPdf = asyncHandler(async (req, res) => {
    const report = await reportData.fullReport(req.params.campaignId, req.user);
    const buffer = await generateCampaignPdf(report);

    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="${safeName(report.summary.name)}_Report_${stamp()}.pdf"`,
      'Content-Length': buffer.length
    });
    res.status(200).send(buffer);
  });

  campaignExcel = asyncHandler(async (req, res) => {
    const report = await reportData.fullReport(req.params.campaignId, req.user);
    // Rows arrive already redacted for this viewer — a client sees contact
    // details only for Qualified/Converted leads.
    const rows = await reportData.leadRows(report.campaign, req.user.role);
    const buffer = await generateCampaignExcel(report, rows);

    res.set({
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="${safeName(report.summary.name)}_Leads_${stamp()}.xlsx"`,
      'Content-Length': buffer.length
    });
    res.status(200).send(Buffer.from(buffer));
  });

  /**
   * Resolve a sequence the requester is allowed to see.
   *
   * A manager reaches it through owning the client; a client portal user
   * reaches it only if it belongs to THEIR client. Both failures return
   * 404 rather than 403 — never confirm someone else's sequence exists.
   */
  _resolveSequence = async (sequenceId, user) => {
    const sequence = await Sequence.findByPk(sequenceId);
    if (!sequence) throw new NotFoundError('Campaign not found.');

    if (user.role === 'client') {
      if (sequence.clientId !== user.clientId) throw new NotFoundError('Campaign not found.');
      return sequence;
    }

    try {
      await assertClientOwnership(sequence.clientId, user.id, { requireActive: false });
    } catch (err) {
      throw new NotFoundError('Campaign not found.');
    }
    return sequence;
  };

  _sequenceRollupWithClient = async (sequence) => {
    const rollup = await sequenceRollup(sequence.id);
    const client = await Client.findByPk(sequence.clientId);
    return { ...rollup, clientName: client ? client.name : null };
  };

  sequencePdf = asyncHandler(async (req, res) => {
    const sequence = await this._resolveSequence(req.params.sequenceId, req.user);
    const rollup = await this._sequenceRollupWithClient(sequence);
    const buffer = await generateSequencePdf(rollup);

    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="${safeName(sequence.name)}_Report_${stamp()}.pdf"`,
      'Content-Length': buffer.length
    });
    res.status(200).send(buffer);
  });

  sequenceExcel = asyncHandler(async (req, res) => {
    const sequence = await this._resolveSequence(req.params.sequenceId, req.user);
    const rollup = await this._sequenceRollupWithClient(sequence);
    const buffer = await generateSequenceExcel(rollup);

    res.set({
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="${safeName(sequence.name)}_Report_${stamp()}.xlsx"`,
      'Content-Length': buffer.length
    });
    res.status(200).send(Buffer.from(buffer));
  });

  /** The same data the reports are built from, as JSON. */
  campaignReportData = asyncHandler(async (req, res) => {
    const report = await reportData.fullReport(req.params.campaignId, req.user);
    res.status(200).json({
      success: true,
      data: {
        summary: report.summary,
        metrics: report.metrics,
        billing: report.billing,
        observations: report.observations
      }
    });
  });
}

module.exports = ReportController;
