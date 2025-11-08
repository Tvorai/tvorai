/**
 * Route: Novita — Merge Face (face swap)
 * Mount: app.use('/api/novita/merge-face', router)
 *
 * Endpoint:
 *  POST /merge  → forward na https://api.novita.ai/v3/merge-face
 *  Body:
 *    { face_image_file: "data:image/...;base64,....", image_file: "data:image/...;base64,....", extra?: {...} }
 *  Response:
 *    { ok: true, image_file: "<base64>", image_type: "png|jpg" }
 */

import express from 'express';
import axios from 'axios';

const router = express.Router();

const NOVITA_API_KEY  = process.env.NOVITA_API_KEY;
const NOVITA_BASE_URL = process.env.NOVITA_BASE_URL || 'https://api.novita.ai';

function assertEnv() {
  if (!NOVITA_API_KEY) {
    const err = new Error('NOVITA_API_KEY chýba v env (Render → Environment).');
    err.status = 500;
    throw err;
  }
}

function stripDataUrlPrefix(b64) {
  if (typeof b64 !== 'string') return b64;
  const idx = b64.indexOf('base64,');
  return idx >= 0 ? b64.slice(idx + 7) : b64;
}

router.post('/merge', async (req, res) => {
  try {
    assertEnv();

    const { face_image_file, image_file, image_type, extra } = req.body || {};
    if (!face_image_file || !image_file) {
      return res.status(400).json({ error: 'MISSING_IMAGES' });
    }

    // ak prišli dataURL, osekaj prefix
    const faceB64 = stripDataUrlPrefix(face_image_file);
    const baseB64 = stripDataUrlPrefix(image_file);

    const payload = {
      face_image_file: faceB64,
      image_file: baseB64,
      ...(image_type ? { image_type } : {}),
      ...(extra && typeof extra === 'object' ? { extra } : {})
    };

    const r = await axios.post(
      `${NOVITA_BASE_URL}/v3/merge-face`,
      payload,
      {
        headers: {
          Authorization: `Bearer ${NOVITA_API_KEY}`,
          'Content-Type': 'application/json'
        },
        timeout: 60000
      }
    );

    const outB64 = r?.data?.image_file || null;
    const outType = r?.data?.image_type || 'png';
    if (!outB64) {
      return res.status(502).json({ error: 'NO_IMAGE_IN_RESPONSE' });
    }

    return res.json({ ok: true, image_file: outB64, image_type: outType });
  } catch (e) {
    const status = e?.status || e?.response?.status || 500;
    const details = e?.response?.data || e?.message || 'Unknown error';
    console.error('merge-face error:', status, details);
    return res.status(status).json({ error: 'SERVER_ERROR', details });
  }
});

export default router;
