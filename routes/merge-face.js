/**
 * Route: Novita – Merge Face
 * Mount: app.use('/api/novita/merge-face', mergeFaceRouter)
 *
 * POST /generate
 *  A) JSON body:  { face_image_file: <base64>, image_file: <base64>, watermark?: 'on'|'off'|true|false|1|0 }
 *  B) multipart:   face_image (file), image_file (file), watermark (text)
 * Response: { ok, image_type, image_base64, data_url }
 */

import express from 'express';
import axios from 'axios';
import multer from 'multer';

const router = express.Router();     // <- toto bolo príčinou chyby
export default router;

const NOVITA_API_KEY  = process.env.NOVITA_API_KEY;
const NOVITA_BASE_URL = process.env.NOVITA_BASE_URL || 'https://api.novita.ai';

function assertEnv() {
  if (!NOVITA_API_KEY) {
    const err = new Error('NOVITA_API_KEY chýba v env (Render → Environment).');
    err.status = 500;
    throw err;
  }
}

// 30 MB limit podľa Novita (max 2048x2048, ale rozlíšenie tu nekontrolujeme)
const upload = multer({ limits: { fileSize: 30 * 1024 * 1024 } });

router.post(
  '/generate',
  upload.fields([
    { name: 'face_image', maxCount: 1 },
    { name: 'image_file', maxCount: 1 },
  ]),
  async (req, res) => {
    try {
      assertEnv();

      // 1) načítaj obrázky (multipart → base64; inak z JSON)
      let faceB64 =
        req.files?.face_image?.[0]?.buffer?.toString('base64') ||
        req.body?.face_image_file ||
        null;

      let imgB64 =
        req.files?.image_file?.[0]?.buffer?.toString('base64') ||
        req.body?.image_file ||
        null;

      if (!faceB64 || !imgB64) {
        return res
          .status(400)
          .json({ error: 'MISSING_IMAGES', detail: 'Pošli face_image + image_file (base64 alebo multipart).' });
      }

      // 2) voliteľný parameter watermark (čítaj on/off/true/false/1/0)
      const wmStr = String(req.body?.watermark ?? 'off').trim().toLowerCase();
      const watermark = !(wmStr === 'off' || wmStr === 'false' || wmStr === '0' || wmStr === 'no');

      // 3) payload na Novita
      const payload = {
        face_image_file: String(faceB64),
        image_file: String(imgB64),
        extra: { watermark }, // ak model nepodporuje, API to ignoruje
      };

      // 4) volanie API
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
        return res
          .status(502)
          .json({ error: 'NO_IMAGE_DATA', detail: 'API nevrátilo image_file (base64).' });
      }

      return res.json({
        ok: true,
        image_type: outType,
        image_base64: outB64,
        data_url: `data:image/${outType};base64,${outB64}`,
      });
    } catch (e) {
      const status  = e?.status || e?.response?.status || 500;
      const details = e?.response?.data || e?.message || 'Unknown error';
      console.error('novita-merge-face error:', status, details);
      return res.status(status).json({ error: 'SERVER_ERROR', details });
    }
  }
);
