'use strict';

/**
 * leadpulse-upload-service — the Lead Import Service.
 *
 * Owns asynchronous lead-file processing: it reads an uploaded file from
 * storage, parses CSV or XLSX, validates and upserts rows in batches, writes
 * an error file for rejected rows, and keeps the import_jobs row updated so
 * the UI can poll progress.
 *
 * The trigger endpoint returns 202 immediately and processing continues
 * detached from that request (SRS 3.1/5.2) — the Core Application never
 * waits on a long-running parse, and the browser never holds a request open.
 */

require('dotenv').config({ path: require('path').resolve(__dirname, '..', '..', '.env') });

const express = require('express');
const winston = require('winston');
const { serviceAuth, sequelize } = require('leadpulse-data-model');
const { processImportJob } = require('./importProcessor.js');

const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(winston.format.timestamp(), winston.format.simple()),
  transports: [new winston.transports.Console()]
});

const app = express();
app.use(express.json());

// Unauthenticated on purpose: deployment health probes need to reach this
// without credentials, and it exposes nothing sensitive (SRS 5.6).
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok', service: 'lead-import' });
});

// Every real endpoint requires the shared service token.
app.use(serviceAuth.requireServiceAuth);

app.post('/process-import/:jobId', (req, res) => {
  const { jobId } = req.params;

  // Respond first, work after — the whole point of the async design.
  res.status(202).json({ success: true, data: { jobId, accepted: true } });

  // Deliberately not awaited: this continues after the response is sent.
  // Errors are handled inside processImportJob and recorded on the job row,
  // so a failure surfaces to the user through polling rather than as an
  // unhandled rejection here.
  processImportJob(jobId, logger).catch((err) => {
    logger.error('Unhandled import processing error', { jobId, message: err.message });
  });
});

app.use((req, res) => {
  res.status(404).json({ success: false, code: 'NOT_FOUND', message: 'Unknown route.' });
});

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  logger.error('Unhandled error', { message: err.message, stack: err.stack });
  res.status(500).json({ success: false, code: 'INTERNAL_SERVER_ERROR', message: 'Something went wrong.' });
});

const PORT = process.env.UPLOAD_SERVICE_PORT || 4001;

(async () => {
  try {
    await sequelize.authenticate();
    logger.info('Lead Import Service connected to the database');
    app.listen(PORT, () => logger.info(`leadpulse-upload-service listening on port ${PORT}`));
  } catch (err) {
    logger.error('Lead Import Service failed to start', { message: err.message });
    process.exit(1);
  }
})();
