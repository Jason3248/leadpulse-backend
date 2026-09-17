'use strict';

const multer = require('multer');
const { ValidationError } = require('../lib');

const MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024; // 10 MB, per SRS 4.3.1

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_SIZE_BYTES },
  fileFilter: (req, file, cb) => {
    // MIME types for CSV/XLSX are inconsistent across browsers and operating
    // systems, so the extension is checked instead — simpler than maintaining
    // an allow-list of every content-type variant in the wild.
    const name = file.originalname.toLowerCase();
    if (name.endsWith('.csv') || name.endsWith('.xlsx') || name.endsWith('.xls')) {
      return cb(null, true);
    }
    cb(new ValidationError('Only .csv, .xlsx and .xls files are supported.'));
  }
});

module.exports = upload.single('file');
