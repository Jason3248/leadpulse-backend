'use strict';

const { z } = require('zod');

// SRS 4.5.1 / 4.7.2: banner images are JPEG or PNG, max 5 MB (validated
// server-side before presigning). The browser sends the filename and
// content type; we never receive the bytes ourselves.
const presignBanner = z.object({
  campaignId: z.string().uuid(),
  contentType: z.enum(['image/jpeg', 'image/png'], {
    errorMap: () => ({ message: 'Banner must be a JPEG or PNG image.' })
  }),
  fileSize: z
    .number()
    .int()
    .positive()
    .max(5 * 1024 * 1024, 'Banner image must be 5 MB or smaller.')
});

module.exports = { presignBanner };
