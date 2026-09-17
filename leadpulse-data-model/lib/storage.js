'use strict';

const fs = require('fs');
const path = require('path');

/**
 * A tiny storage abstraction with two drivers behind one interface:
 *
 *   STORAGE_DRIVER=local  -> writes under ./storage (default; no AWS needed)
 *   STORAGE_DRIVER=s3     -> writes to the configured S3 bucket
 *
 * The point is that nothing calling this cares which driver is active — the
 * import service and API both just put/get/delete by key. Local is the
 * default so the project runs end to end on a laptop with no AWS account,
 * and switching to S3 for the AWS deployment is one environment variable,
 * not a code change.
 */

const DRIVER = process.env.STORAGE_DRIVER || 'local';

// Resolved relative to this package, NOT process.cwd() — each service runs
// from its own working directory, so a cwd-relative path would give the API
// and the import service two different folders and the handoff would break.
// An absolute LOCAL_STORAGE_PATH always wins if one is set.
const LOCAL_ROOT = process.env.LOCAL_STORAGE_PATH
  ? path.resolve(process.env.LOCAL_STORAGE_PATH)
  : path.resolve(__dirname, '..', '..', 'storage');

// --- local driver -----------------------------------------------------

const localPathFor = (key) => path.join(LOCAL_ROOT, key);

const local = {
  async put(key, buffer) {
    const full = localPathFor(key);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, buffer);
    return key;
  },
  async get(key) {
    return fs.promises.readFile(localPathFor(key));
  },
  async delete(key) {
    try {
      await fs.promises.unlink(localPathFor(key));
    } catch (err) {
      if (err.code !== 'ENOENT') throw err; // already gone is fine
    }
  },
  async exists(key) {
    return fs.existsSync(localPathFor(key));
  },
  // The browser PUTs directly to this URL. Locally there's no S3 to accept
  // it, so we point at an app endpoint that stores the bytes via put() —
  // the browser-side flow (request URL, PUT the file, use the public URL)
  // is then identical whether the driver is local or s3.
  async presignUpload(key) {
    const base = process.env.TRACKING_BASE_URL || 'http://localhost:4000/api/v1';
    return {
      uploadUrl: `${base}/uploads/local?key=${encodeURIComponent(key)}`,
      method: 'PUT',
      publicUrl: `${base}/uploads/local?key=${encodeURIComponent(key)}`
    };
  }
};

// --- s3 driver --------------------------------------------------------
// The AWS SDK is only required when actually using S3, so a local-only
// setup doesn't need the dependency installed at all.

let s3Client = null;
const getS3 = () => {
  if (!s3Client) {
    // eslint-disable-next-line global-require
    const { S3Client } = require('@aws-sdk/client-s3');
    s3Client = new S3Client({ region: process.env.AWS_REGION });
  }
  return s3Client;
};

const s3 = {
  async put(key, buffer) {
    const { PutObjectCommand } = require('@aws-sdk/client-s3');
    await getS3().send(
      new PutObjectCommand({ Bucket: process.env.S3_BUCKET, Key: key, Body: buffer })
    );
    return key;
  },
  async get(key) {
    const { GetObjectCommand } = require('@aws-sdk/client-s3');
    const res = await getS3().send(new GetObjectCommand({ Bucket: process.env.S3_BUCKET, Key: key }));
    const chunks = [];
    for await (const chunk of res.Body) chunks.push(chunk);
    return Buffer.concat(chunks);
  },
  async delete(key) {
    const { DeleteObjectCommand } = require('@aws-sdk/client-s3');
    await getS3().send(new DeleteObjectCommand({ Bucket: process.env.S3_BUCKET, Key: key }));
  },
  async exists(key) {
    const { HeadObjectCommand } = require('@aws-sdk/client-s3');
    try {
      await getS3().send(new HeadObjectCommand({ Bucket: process.env.S3_BUCKET, Key: key }));
      return true;
    } catch (err) {
      return false;
    }
  },
  // Presigned PUT so the browser uploads the image straight to S3, never
  // through our app server (SRS 4.7.2). The URL is valid for 5 minutes. The
  // returned publicUrl is the durable object URL embedded in the email.
  async presignUpload(key, contentType) {
    const { PutObjectCommand } = require('@aws-sdk/client-s3');
    const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
    const command = new PutObjectCommand({
      Bucket: process.env.S3_BUCKET,
      Key: key,
      ContentType: contentType
    });
    const uploadUrl = await getSignedUrl(getS3(), command, { expiresIn: 300 });
    const region = process.env.AWS_REGION;
    const publicUrl = `https://${process.env.S3_BUCKET}.s3.${region}.amazonaws.com/${key}`;
    return { uploadUrl, method: 'PUT', publicUrl };
  }
};

const driver = DRIVER === 's3' ? s3 : local;

module.exports = {
  driverName: DRIVER,
  put: driver.put,
  get: driver.get,
  delete: driver.delete,
  exists: driver.exists,
  presignUpload: driver.presignUpload,
  // Key layout mirrors the SRS: /imports/{jobId}/source.ext and
  // /imports/{jobId}/errors.csv
  sourceKey: (jobId, ext) => `imports/${jobId}/source${ext}`,
  errorKey: (jobId) => `imports/${jobId}/errors.csv`,
  // Reports are generated on demand and streamed straight to the caller, so
  // these keys exist only for the optional case of retaining a copy (SRS
  // 4.9.1 mentions 24h retention). Nothing in the app depends on a report
  // being stored — regenerating is always cheaper than managing stale files.
  reportKey: (campaignId, filename) => `reports/${campaignId}/${filename}`,
  // Banner images, per SRS 4.7.2: /images/{campaignId}/{uuid}.{ext}
  bannerKey: (campaignId, uuid, ext) => `images/${campaignId}/${uuid}${ext}`
};
