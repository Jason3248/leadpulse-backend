'use strict';

const { storage } = require('leadpulse-data-model');
const uploadService = require('./upload.service.js');
const asyncHandler = require('../../utils/asyncHandler.js');
const { ValidationError, NotFoundError } = require('../../lib');

const MAX_BANNER_BYTES = 5 * 1024 * 1024;
const ALLOWED_KEY = /^images\/[0-9a-f-]+\/[0-9a-f-]+\.(jpg|png)$/i;
const CONTENT_TYPE_BY_EXT = { jpg: 'image/jpeg', png: 'image/png' };

class UploadController {
  presignBanner = asyncHandler(async (req, res) => {
    const result = await uploadService.presignBanner({ ...req.body, managerId: req.user.id });
    res.status(200).json({ success: true, data: result });
  });

  /**
   * Local-driver stand-in for a direct-to-S3 PUT. Only mounted meaningfully
   * when STORAGE_DRIVER=local; with S3 the browser PUTs straight to the
   * presigned S3 URL and never touches this. Deliberately unauthenticated
   * for the same reason a presigned S3 URL is: the unguessable key IS the
   * capability. We still hard-constrain what that key may look like and cap
   * the size, so it can't be used to write arbitrary paths or huge files.
   */
  receiveLocal = asyncHandler(async (req, res) => {
    const key = req.query.key;
    if (!key || !ALLOWED_KEY.test(key)) {
      throw new ValidationError('Invalid or missing upload key.');
    }
    const body = req.body;
    if (!Buffer.isBuffer(body) || body.length === 0) {
      throw new ValidationError('No file content received.');
    }
    if (body.length > MAX_BANNER_BYTES) {
      throw new ValidationError('Banner image must be 5 MB or smaller.');
    }
    await storage.put(key, body);
    res.status(200).json({ success: true, data: { key } });
  });

  serveLocal = asyncHandler(async (req, res) => {
    const key = req.query.key;
    if (!key || !ALLOWED_KEY.test(key)) throw new ValidationError('Invalid or missing key.');

    let buffer;
    try {
      buffer = await storage.get(key);
    } catch (err) {
      throw new NotFoundError('Image not found.');
    }
    const ext = key.split('.').pop().toLowerCase();
    res.set({
      'Content-Type': CONTENT_TYPE_BY_EXT[ext] || 'application/octet-stream',
      'Cache-Control': 'public, max-age=86400'
    });
    res.status(200).send(buffer);
  });
}

module.exports = UploadController;
