/**
 * Route: Novita – Merge Face (with S3 upload)
 * Mount:  app.use('/api/novita/merge-face', mergeFaceRouter)
 */

import express from 'express';
import axios from 'axios';
import multer from 'multer';
import AWS from 'aws-sdk';
import crypto from 'crypto';

const router = express.Router();
export default router;

// ------------------------------
// ENV VARS
// ------------------------------
const NOVITA_API_KEY  = process.env.NOVITA_API_KEY;
const NOVITA_BASE_URL = process.env.NOVITA_BASE_URL || 'https://api.novita.ai';

const AWS_ACCESS_KEY = process.env.AWS_ACCESS_KEY;
const AWS_SECRET_KEY = process.env.AWS_SECRET_KEY;
const AWS_BUCKET     = process.env.AWS_BUCKET;
const AWS_REGION     = process.env.AWS_REGION;

// ------------------------------
// Init S3
// ------------------------------
AWS.config.update({
  accessKeyId: AWS_ACCESS_KEY,
  secretAccessKey: AWS_SECRET_KEY,
  region: AWS_REGION,
});

const s3 = new AWS.S3();

function assertEnv() {
  if (!NOVITA_API_KEY) throw new Error('NOVITA_API_KEY missing');
  if (!AWS_ACCESS_KEY || !AWS_SECRET_KEY) throw new Error('AWS credentials missing');
  if (!AWS_BUCKET) throw new Error('AWS_BUCKET missing');
}

// 30 MB limit
const upload = multer({ limits: { fileSize: 30 * 1024 * 1024 } });

// ------------------------------
// ROUTE
// ------------------------------
router.post(
  '/generate',
  upload.fields([
    { name: 'face_image', maxCount: 1 },
    { name: 'image_file', maxCount: 1 },
  ]),
  async (req, res) => {
    try {
      assertEnv();

      // 1) INPUT: base64 or multipart
      let faceB64 =
        req.files?.face_image?.[0]?.buffer?.toString('base64') ||
        req.body?.face_image_file ||
        null;

      let imgB64 =
        req.files?.image_file?.[0]?.buffer?.toString('base64') ||
        req.body?.image_file ||
        null;

      if (!faceB64 || !imgB64) {
        return res.status(400).json({
          ok: false,
          error: 'MISSING_IMAGES',
        });
      }

      // watermark: on/off
      const wmStr = String(req.body?.watermark ?? 'off').trim().toLowerCase();
      const watermark = !(wmStr === 'off' || wmStr === 'false' || wmStr === '0' || wmStr === 'no');

      // 2) Novita API call
      const payload = {
        face_image_file: faceB64,
        image_file: imgB64,
        extra: { watermark },
      };

      const r = await axios.post(`${NOVITA_BASE_URL}/v3/merge-face`, payload, {
        headers: {
          Authorization: `Bearer ${NOVITA_API_KEY}`,
          'Content-Type': 'application/json',
        },
        timeout: 90000,
      });

      const outB64 = r?.data?.image_file;
      const outType = r?.data?.image_type || 'png';

      if (!outB64) {
        return res.status(500).json({
          ok: false,
          error: 'NO_IMAGE_FROM_API',
        });
      }

      // 3) Convert base64 → buffer
      const buffer = Buffer.from(outB64, 'base64');

      // S3 filename
      const filename = `faceswap/${crypto.randomUUID()}.${outType}`;

      // 4) S3 upload
      await s3
        .upload({
          Bucket: AWS_BUCKET,
          Key: filename,
          Body: buffer,
          ContentType: `image/${outType}`,
          ACL: 'private',
        })
        .promise();

      // Signed URL (24h)
      const signedUrl = s3.getSignedUrl('getObject', {
        Bucket: AWS_BUCKET,
        Key: filename,
        Expires: 86400,
      });

      // 5) Response
      return res.json({
        ok: true,
        url: signedUrl,
        file: filename,
        mime: `image/${outType}`,
      });

    } catch (e) {
      console.error('merge-face error:', e);
      return res.status(500).json({
        ok: false,
        error: e?.response?.data || e.message || 'SERVER_ERROR',
      });
    }
  }
);
