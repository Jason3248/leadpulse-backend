'use strict';

const crypto = require('crypto');
const { Campaign, storage } = require('leadpulse-data-model');
const { NotFoundError, BusinessRuleError } = require('../../lib');
const assertClientOwnership = require('../client/assertClientOwnership.js');

const EXT_BY_TYPE = { 'image/jpeg': '.jpg', 'image/png': '.png' };

class UploadService {
  /**
   * Issue a presigned URL for a banner image. The browser then PUTs the
   * file straight to storage (S3 in production, a local endpoint in dev) —
   * the bytes never pass through this API server, per SRS 4.7.2.
   *
   * We validate ownership and file constraints BEFORE presigning, so a URL
   * is only ever handed out for a campaign this manager actually owns.
   */
  async presignBanner({ campaignId, contentType, managerId }) {
    const campaign = await Campaign.findByPk(campaignId);
    if (!campaign) throw new NotFoundError('Campaign not found.');

    try {
      await assertClientOwnership(campaign.clientId, managerId, { requireActive: true });
    } catch (err) {
      if (err instanceof NotFoundError) throw new NotFoundError('Campaign not found.');
      throw err;
    }

    if (campaign.type !== 'email') {
      throw new BusinessRuleError('Banner images apply only to email campaigns.');
    }
    // Once approved the audience is frozen and the campaign is live/sent;
    // swapping the banner then would change what already-sent emails
    // referenced. Only editable while still a draft.
    if (campaign.status !== 'draft') {
      throw new BusinessRuleError('The banner can only be changed while the campaign is a draft.');
    }

    const ext = EXT_BY_TYPE[contentType];
    const key = storage.bannerKey(campaignId, crypto.randomUUID(), ext);
    const { uploadUrl, method, publicUrl } = await storage.presignUpload(key, contentType);

    return { uploadUrl, method, publicUrl, key };
  }
}

module.exports = new UploadService();
