'use strict';

const { parse } = require('csv-parse/sync');
const XLSX = require('xlsx');
const {
  Lead,
  ClientLead,
  LeadList,
  LeadListMembership,
  ImportJob,
  sequelize,
  constants,
  storage
} = require('leadpulse-data-model');

const { IMPORT_JOB_STATUS, MEMBERSHIP_STATUS } = constants;

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// Rows are committed in batches rather than one giant transaction so a large
// file doesn't hold a single long-running transaction open, and so progress
// is visible to the polling UI while the job is still running (SRS 5.5).
const BATCH_SIZE = 100;

const cleanCell = (value) => String(value ?? '').trim();

/** Parses either CSV or XLSX into an array of row objects keyed by header. */
function parseFile(buffer, filename) {
  if (filename.toLowerCase().endsWith('.xlsx') || filename.toLowerCase().endsWith('.xls')) {
    const workbook = XLSX.read(buffer, { type: 'buffer' });
    const firstSheet = workbook.Sheets[workbook.SheetNames[0]];
    if (!firstSheet) throw new Error('The spreadsheet has no sheets.');
    return XLSX.utils.sheet_to_json(firstSheet, { defval: '' });
  }
  return parse(buffer, { columns: true, trim: true, skip_empty_lines: true });
}

/** Builds the downloadable error CSV: the original row plus a reason column. */
function buildErrorCsv(failedRows) {
  const header = 'row_number,first_name,last_name,email,phone,company,job_title,industry,source,error_reason';
  const escape = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const lines = failedRows.map((f) =>
    [
      f.rowNumber,
      f.data.firstName,
      f.data.lastName,
      f.data.email,
      f.data.phone,
      f.data.company,
      f.data.jobTitle,
      f.data.industry,
      f.data.source,
      f.reason
    ]
      .map(escape)
      .join(',')
  );
  return Buffer.from([header, ...lines].join('\n'), 'utf8');
}

/**
 * Processes one import job end to end. Runs detached from the HTTP request
 * that triggered it — the caller has already received a 202 with the job id,
 * and everything from here is reported through the import_jobs row that the
 * UI polls.
 */
async function processImportJob(jobId, logger) {
  const job = await ImportJob.findByPk(jobId);
  if (!job) {
    logger.warn('Import job not found', { jobId });
    return;
  }

  try {
    await job.update({ status: IMPORT_JOB_STATUS.PROCESSING, startedAt: new Date() });

    const buffer = await storage.get(job.sourceFileKey);
    const rows = parseFile(buffer, job.originalFilename);

    if (rows.length === 0) {
      await finish(job, IMPORT_JOB_STATUS.FAILED, { failureReason: 'The uploaded file has no data rows.' });
      return;
    }

    await job.update({ totalRows: rows.length });

    // Resolve (or create) the destination list once, before any rows land.
    const leadList = await resolveLeadList(job);
    await job.update({ leadListId: leadList.id });

    const counters = { successful: 0, failed: 0, newToAgency: 0, matched: 0, alreadyMapped: 0 };
    const failedRows = [];

    for (let start = 0; start < rows.length; start += BATCH_SIZE) {
      const batch = rows.slice(start, start + BATCH_SIZE);

      // One transaction per batch: a bad row inside a batch rolls back only
      // that batch, and rows already committed stay committed (SRS 5.2:
      // "Failed individual lead rows do not fail the entire import").
      await sequelize.transaction(async (transaction) => {
        for (let i = 0; i < batch.length; i++) {
          const row = batch[i];
          const rowNumber = start + i + 2; // +1 for 0-index, +1 for header

          const rowData = {
            firstName: cleanCell(row.first_name),
            lastName: cleanCell(row.last_name),
            email: cleanCell(row.email),
            phone: cleanCell(row.phone),
            company: cleanCell(row.company),
            jobTitle: cleanCell(row.job_title),
            industry: cleanCell(row.industry),
            source: cleanCell(row.source)
          };

          const email = rowData.email.toLowerCase();

          if (!email || !EMAIL_REGEX.test(email)) {
            counters.failed++;
            failedRows.push({ rowNumber, data: rowData, reason: 'Missing or invalid email' });
            continue;
          }
          if (!rowData.firstName) {
            counters.failed++;
            failedRows.push({ rowNumber, data: rowData, reason: 'Missing first name' });
            continue;
          }

          const outcome = await upsertLead({ email, rowData, clientId: job.clientId, leadListId: leadList.id, transaction });
          counters.successful++;
          if (outcome === 'new') counters.newToAgency++;
          else if (outcome === 'matched') counters.matched++;
          else counters.alreadyMapped++;
        }
      });

      // Progress is written after each committed batch so the polling UI sees
      // it advance rather than jumping from 0 to 100 at the end.
      await job.update({
        processedRows: Math.min(start + batch.length, rows.length),
        successfulRows: counters.successful,
        failedRows: counters.failed,
        newToAgency: counters.newToAgency,
        matchedFromAgencyDatabase: counters.matched,
        alreadyMappedToClient: counters.alreadyMapped
      });
    }

    let errorFileKey = null;
    if (failedRows.length > 0) {
      errorFileKey = storage.errorKey(job.id);
      await storage.put(errorFileKey, buildErrorCsv(failedRows));
    }

    await finish(
      job,
      failedRows.length > 0 ? IMPORT_JOB_STATUS.COMPLETED_WITH_ERRORS : IMPORT_JOB_STATUS.COMPLETED,
      { errorFileKey }
    );
    logger.info('Import job finished', { jobId, status: job.status, ...counters });
  } catch (err) {
    logger.error('Import job failed', { jobId, message: err.message, stack: err.stack });
    // The stored reason is user-safe — internals stay in the logs.
    await finish(job, IMPORT_JOB_STATUS.FAILED, {
      failureReason: 'The file could not be processed. Please check the format and try again.'
    });
  }
}

async function resolveLeadList(job) {
  if (job.leadListId) {
    const existing = await LeadList.findByPk(job.leadListId);
    if (existing) return existing;
  }
  // Reuse a same-named list rather than creating a duplicate — same rule the
  // synchronous path applies.
  const existingByName = await LeadList.findOne({
    where: { clientId: job.clientId, name: job.leadListName }
  });
  if (existingByName) return existingByName;

  return LeadList.create({
    clientId: job.clientId,
    name: job.leadListName,
    importedByUserId: job.startedByUserId
  });
}

/**
 * The two-tier upsert: a global Lead identity matched by email, plus this
 * Client's own relationship row. Consent flags on client_leads are never
 * touched by an import — only explicit actions change those.
 */
async function upsertLead({ email, rowData, clientId, leadListId, transaction }) {
  const [lead, leadWasCreated] = await Lead.findOrCreate({
    where: { email },
    defaults: {
      email,
      firstName: rowData.firstName,
      lastName: rowData.lastName || null,
      phone: rowData.phone || null,
      company: rowData.company || null,
      jobTitle: rowData.jobTitle || null,
      industry: rowData.industry || null,
      source: rowData.source || null
    },
    transaction
  });

  if (!leadWasCreated) {
    await lead.update(
      {
        firstName: rowData.firstName,
        lastName: rowData.lastName || lead.lastName,
        phone: rowData.phone || lead.phone,
        company: rowData.company || lead.company,
        jobTitle: rowData.jobTitle || lead.jobTitle,
        industry: rowData.industry || lead.industry,
        source: rowData.source || lead.source
      },
      { transaction }
    );
  }

  const [, clientLeadWasCreated] = await ClientLead.findOrCreate({
    where: { clientId, leadId: lead.id },
    defaults: { clientId, leadId: lead.id },
    transaction
  });

  // First time in THIS list starts fresh at New regardless of standing on
  // any other list; an existing membership keeps whatever progress it has.
  await LeadListMembership.findOrCreate({
    where: { leadListId, leadId: lead.id },
    defaults: { leadListId, leadId: lead.id, status: MEMBERSHIP_STATUS.NEW },
    transaction
  });

  if (leadWasCreated) return 'new';
  if (clientLeadWasCreated) return 'matched';
  return 'alreadyMapped';
}

/** Terminal transition: record the outcome and clean up the source file. */
async function finish(job, status, extra = {}) {
  await job.update({ status, finishedAt: new Date(), ...extra });

  // The source file exists only for the duration of processing (SRS 2.4).
  if (job.sourceFileKey) {
    try {
      await storage.delete(job.sourceFileKey);
      await job.update({ sourceFileKey: null });
    } catch (err) {
      // A failed cleanup shouldn't flip a successful import to failed.
    }
  }
}

module.exports = { processImportJob };
