/**
 * Route: Novita – Merge Face + AWS S3 upload
 * Mount: app.use('/api/novita/merge-face', mergeFaceRouter)
 */

import express from 'express';
import axios from 'axios';
import multer from 'multer';
import AWS from 'aws-sdk';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

const router = express.Router();
export default router;

// == NOVITA ==
const NOVITA_API_KEY  = process.env.NOVITA_API_KEY;
const NOVITA_BASE_URL = process.env.NOVITA_BASE_URL || 'https://api.novita.ai';

// == AWS S3 ==
const S3 = new AWS.S3({
  region: process.env.AWS_REGION,
  accessKeyId: process.env.AWS_ACCESS_KEY,
  secretAccessKey: process.env.AWS_SECRET_KEY,
});

const AWS_BUCKET = process.env.AWS_BUCKET;

function assertEnv() {
  if (!NOVITA_API_KEY) throw new Error('NOVITA_API_KEY missing');
  if (!process.env.AWS_ACCESS_KEY) throw new Error('AWS_ACCESS_KEY missing');
  if (!process.env.AWS_SECRET_KEY) throw new Error('AWS_SECRET_KEY missing');
  if (!process.env.AWS_REGION)     throw new Error('AWS_REGION missing');
  if (!process.env.AWS_BUCKET)     throw new Error('AWS_BUCKET missing');
}

// ============================
// MULTER → DISK (/tmp)
// ============================
const uploadDir = '/tmp/merge-face';
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadDir),
  filename: (req, file, cb) => {
    const unique = crypto.randomBytes(8).toString('hex');
    cb(null, `${Date.now()}-${unique}${path.extname(file.originalname)}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 30 * 1024 * 1024 }, // 30 MB
});

router.post(
  '/generate',
  upload.fields([
    { name: 'face_image', maxCount: 1 },
    { name: 'image_file', maxCount: 1 },
  ]),
  async (req, res) => {
    let facePath, imagePath;

    try {
      assertEnv();

      // === 1) načítanie obrázkov ===
      facePath  = req.files?.face_image?.[0]?.path || null;
      imagePath = req.files?.image_file?.[0]?.path || null;

      let faceB64 =
        facePath
          ? fs.readFileSync(facePath).toString('base64')
          : req.body?.face_image_file || null;

      let imgB64 =
        imagePath
          ? fs.readFileSync(imagePath).toString('base64')
          : req.body?.image_file || null;

      if (!faceB64 || !imgB64) {
        return res.status(400).json({
          ok: false,
          error: 'MISSING_IMAGES',
          detail: 'face_image + image_file (base64 alebo multipart) sú povinné.',
        });
      }

      // === 2) watermark ===
      const wmStr = String(req.body?.watermark ?? 'off').trim().toLowerCase();
      const watermark = !(wmStr === 'off' || wmStr === 'false' || wmStr === '0' || wmStr === 'no');

      // === 3) volanie Novita ===
      const payload = {
        face_image_file: String(faceB64),
        image_file: String(imgB64),
        extra: { watermark },
      };

      const r = await axios.post(`${NOVITA_BASE_URL}/v3/merge-face`, payload, {
        headers: {
          Authorization: `Bearer ${NOVITA_API_KEY}`,
          'Content-Type': 'application/json',
        },
        timeout: 60000,
      });

      const outB64  = r?.data?.image_file || null;
      const outType = r?.data?.image_type || 'png';

      if (!outB64) {
        return res.status(502).json({
          ok: false,
          error: 'NO_IMAGE_DATA',
          detail: 'Novita API nevrátilo image_file.',
        });
      }

      // === 4) upload do AWS S3 ===
      const fileName = `merge-face_${Date.now()}.${outType}`;
      const buffer = Buffer.from(outB64, 'base64');

      const uploadRes = await S3.upload({
        Bucket: AWS_BUCKET,
        Key: fileName,
        Body: buffer,
        ContentType: `image/${outType}`,
        ACL: 'public-read',
      }).promise();

      const url = uploadRes.Location;

      // === 5) návrat na WP ===
      return res.json({
        ok: true,
        image_type: outType,
        image_base64: outB64,
        data_url: `data:image/${outType};base64,${outB64}`,
        url,
      });

    } catch (e) {
      const status = e?.status || e?.response?.status || 500;
      const details = e?.response?.data || e?.message || 'Unknown error';
      console.error('merge-face error:', status, details);

      return res.status(status).json({
        ok: false,
        error: 'SERVER_ERROR',
        details,
      });

    } finally {
      // cleanup /tmp
      if (facePath) fs.unlink(facePath, () => {});
      if (imagePath) fs.unlink(imagePath, () => {});
    }
  }
);
