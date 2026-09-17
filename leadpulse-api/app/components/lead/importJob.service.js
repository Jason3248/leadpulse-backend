'use strict';

const path = require('path');
const { ImportJob, LeadList, storage, serviceAuth, constants, Sequelize } = require('leadpulse-data-model');
const { NotFoundError, ValidationError, BusinessRuleError, UpstreamServiceError } = require('../../lib');
const assertClientOwnership = require('../client/assertClientOwnership.js');
const logger = require('../../configs/logger.js');

const { Op } = Sequelize;
const { IMPORT_JOB_STATUS } = constants;

const UPLOAD_SERVICE_URL = process.env.UPLOAD_SERVICE_URL || 'http://localhost:4001';

// How long a job may sit in "processing" before it's treated as abandoned.
// Deliberately generous — far longer than any legitimate 10 MB import — so
// this only ever catches a genuinely dead job, never a slow one.
const STALE_PROCESSING_MS = 30 * 60 * 1000; // 30 minutes

const toPublicJob = (job) => ({
  id: job.id,
  clientId: job.clientId,
  leadListId: job.leadListId,
  leadListName: job.leadListName,
  originalFilename: job.originalFilename,
  status: job.status,
  totalRows: job.totalRows,
  processedRows: job.processedRows,
  successfulRows: job.successfulRows,
  failedRows: job.failedRows,
  progressPercentage: job.progressPercentage(),
  // Breakdown of the successful rows — same three-way split the synchronous
  // import used to return inline.
  newToAgency: job.newToAgency,
  matchedFromAgencyDatabase: job.matchedFromAgencyDatabase,
  alreadyMappedToClient: job.alreadyMappedToClient,
  hasErrorFile: Boolean(job.errorFileKey),
  failureReason: job.failureReason,
  startedAt: job.startedAt,
  finishedAt: job.finishedAt,
  createdAt: job.createdAt
});

class ImportJobService {
  /**
   * Accepts the upload, records the job, and hands off. Returns as soon as
   * the file is safely stored — parsing happens in the Lead Import Service,
   * and the caller polls getStatus() from here on.
   */
  async startImport({ clientId, leadListId, leadListName, fileBuffer, filename, managerId }) {
    await assertClientOwnership(clientId, managerId, { requireActive: true });

    if (leadListId) {
      const list = await LeadList.findOne({ where: { id: leadListId, clientId } });
      if (!list) throw new NotFoundError('Lead list not found for this client.');
      if (list.status === constants.LEAD_LIST_STATUS.ARCHIVED) {
        throw new BusinessRuleError('That lead list is archived and cannot receive new imports.');
      }
    }

    const job = await ImportJob.create({
      clientId,
      leadListId: leadListId || null,
      leadListName: leadListName || null,
      startedByUserId: managerId,
      originalFilename: filename,
      status: IMPORT_JOB_STATUS.UPLOADED
    });

    // Store the source file before triggering, so the service always has
    // something to read when it picks the job up.
    const key = storage.sourceKey(job.id, path.extname(filename).toLowerCase() || '.csv');
    try {
      await storage.put(key, fileBuffer);
      await job.update({ sourceFileKey: key, status: IMPORT_JOB_STATUS.QUEUED });
    } catch (err) {
      logger.error('Failed to store import source file', { jobId: job.id, message: err.message });
      await job.update({
        status: IMPORT_JOB_STATUS.FAILED,
        failureReason: 'The file could not be stored for processing. Please try again.'
      });
      throw new UpstreamServiceError('The file could not be stored for processing. Please try again shortly.');
    }

    await this._triggerImportService(job);

    return toPublicJob(job);
  }

  async getStatus(jobId, managerId) {
    const job = await this._getOwnedJob(jobId, managerId);
    await this._failIfStale(job);
    return toPublicJob(job);
  }

  async list({ clientId, managerId, status }) {
    if (!clientId) throw new ValidationError('clientId query parameter is required.');
    await assertClientOwnership(clientId, managerId, { requireActive: false });

    const where = { clientId };
    if (status) where.status = status;

    const jobs = await ImportJob.findAll({ where, order: [['createdAt', 'DESC']], limit: 50 });
    await Promise.all(jobs.map((job) => this._failIfStale(job)));
    return jobs.map(toPublicJob);
  }

  /**
   * Rescues a job abandoned mid-processing. If the import service crashes or
   * its container is restarted (a routine event on ECS/Fargate during a
   * deploy or scale-in), nothing else would ever move the job off
   * "processing" — so the UI, which polls while the job is non-terminal,
   * would poll forever behind a progress bar that never advances.
   *
   * Checked lazily on read rather than by a background sweeper: there's no
   * scheduler to own it, and a stuck job only matters at the moment someone
   * actually looks at it.
   */
  async _failIfStale(job) {
    if (job.status !== IMPORT_JOB_STATUS.PROCESSING || !job.startedAt) return;
    if (Date.now() - new Date(job.startedAt).getTime() < STALE_PROCESSING_MS) return;

    logger.warn('Marking a stalled import job as failed', { jobId: job.id, startedAt: job.startedAt });
    await job.update({
      status: IMPORT_JOB_STATUS.FAILED,
      failureReason: 'Processing stopped unexpectedly and did not finish. Please retry this import.',
      finishedAt: new Date()
    });
  }

  /** Returns the error CSV contents for download. */
  async getErrorFile(jobId, managerId) {
    const job = await this._getOwnedJob(jobId, managerId);
    if (!job.errorFileKey) {
      throw new NotFoundError('This import has no error records to download.');
    }

    // The file is retained only for a limited window, so a stale reference
    // is an expected outcome rather than an error worth alarming about.
    const exists = await storage.exists(job.errorFileKey);
    if (!exists) {
      throw new NotFoundError('The error file for this import is no longer available.');
    }

    const buffer = await storage.get(job.errorFileKey);
    return { buffer, filename: `import_errors_${job.id}.csv` };
  }

  async _triggerImportService(job) {
    try {
      const response = await fetch(`${UPLOAD_SERVICE_URL}/process-import/${job.id}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...serviceAuth.serviceAuthHeaders() }
      });
      if (!response.ok) {
        throw new Error(`Import service responded ${response.status}`);
      }
    } catch (err) {
      // The job row is the source of truth the UI polls, so a failed trigger
      // is recorded there rather than only thrown — otherwise the job would
      // sit at "queued" forever with no explanation.
      logger.error('Failed to trigger the import service', { jobId: job.id, message: err.message });
      await job.update({
        status: IMPORT_JOB_STATUS.FAILED,
        failureReason: 'The import service is currently unavailable. Please retry this import.',
        finishedAt: new Date()
      });
      throw new UpstreamServiceError('The import service is currently unavailable. Please try again shortly.');
    }
  }

  async _getOwnedJob(jobId, managerId) {
    const job = await ImportJob.findByPk(jobId);
    if (!job) throw new NotFoundError('Import job not found.');
    try {
      await assertClientOwnership(job.clientId, managerId, { requireActive: false });
    } catch (err) {
      if (err instanceof NotFoundError) throw new NotFoundError('Import job not found.');
      throw err;
    }
    return job;
  }
}

module.exports = new ImportJobService();
