'use strict';

const leadService = require('./lead.service.js');
const importJobService = require('./importJob.service.js');
const asyncHandler = require('../../utils/asyncHandler.js');
const { ValidationError } = require('../../lib');

class LeadController {
  // Returns immediately with a job id; the file is processed by the Lead
  // Import Service and progress is retrieved via importStatus below.
  import = asyncHandler(async (req, res) => {
    if (!req.file) {
      throw new ValidationError('No file uploaded. Attach a .csv or .xlsx file under the "file" field.');
    }

    const job = await importJobService.startImport({
      ...req.body,
      fileBuffer: req.file.buffer,
      filename: req.file.originalname,
      managerId: req.user.id
    });

    res.status(202).json({ success: true, data: job });
  });

  importStatus = asyncHandler(async (req, res) => {
    const job = await importJobService.getStatus(req.params.jobId, req.user.id);
    res.status(200).json({ success: true, data: job });
  });

  importHistory = asyncHandler(async (req, res) => {
    const jobs = await importJobService.list({ ...req.query, managerId: req.user.id });
    res.status(200).json({ success: true, data: jobs });
  });

  importErrorFile = asyncHandler(async (req, res) => {
    const { buffer, filename } = await importJobService.getErrorFile(req.params.jobId, req.user.id);
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.status(200).send(buffer);
  });

  list = asyncHandler(async (req, res) => {
    const result = await leadService.list({ ...req.query, managerId: req.user.id });
    res.status(200).json({ success: true, data: result.leads, pagination: result.pagination });
  });

  getById = asyncHandler(async (req, res) => {
    const lead = await leadService.getById(req.params.id, req.user.id, req.query.clientId);
    res.status(200).json({ success: true, data: lead });
  });

  updateDnc = asyncHandler(async (req, res) => {
    const lead = await leadService.setDnc(req.params.id, req.user.id, req.body.clientId, req.body.dnc);
    res.status(200).json({ success: true, data: lead });
  });

  updateStatus = asyncHandler(async (req, res) => {
    const membership = await leadService.updateStatus(req.params.id, req.user.id, req.body);
    res.status(200).json({ success: true, data: membership });
  });
}

module.exports = LeadController;
