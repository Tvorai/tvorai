/**
 * Route: Seedream 3.0 — Text to Image
 * Mount: app.use('/api/seedream/3/t2i', router)
 *
 * Endpoints:
 *  POST /generate  → zavolá Novita a vráti image_urls (alebo b64)
 */

import express from 'express';
import axios from 'axios';

const router = express.Router();
export default router;

const NOVITA_API_KEY  = process.env.NOVITA_API_KEY;
const NOVITA_BASE_URL = process.env.NOVITA_BASE_URL || 'https://api.novita.ai';

function assertEnv () {
  if (!NOVITA_API_KEY) {
    const err = new Error('NOVITA_API_KEY chýba v env (Render → Environment).');
    err.status = 500;
    throw err;
  }
}

// Bez pollingu – priamy sync POST
router.post('/generate', async (req, res) => {
  try {
    assertEnv();

    const {
      prompt,
      model = 'seedream-3-0-t2i-250415',
      response_format = 'url',   // 'url' | 'b64_json'
      size = '1024x1024',
      seed = -1,
      guidance_scale = 2.5,
      // môže prísť 'on' | 'off' | 'true' | 'false' | 1 | 0
      watermark: watermarkRaw = 'off',
    } = req.body || {};

    if (!prompt || typeof prompt !== 'string' || !prompt.trim()) {
      return res.status(400).json({ error: "Missing or empty 'prompt'." });
    }

    // validácia size ~ základ
    const sizeRe = /^(\d{3,4})x(\d{3,4})$/;
    if (!sizeRe.test(size)) {
      return res.status(400).json({ error: "Invalid 'size' (e.g., 1024x1024)." });
    }

    // normalize watermark -> boolean
    const wmStr = String(watermarkRaw).trim().toLowerCase();
    const watermark =
      !(wmStr === 'off' || wmStr === 'false' || wmStr === '0' || wmStr === 'no');

    // priprav payload podľa Novita
    const payload = {
      model,
      input: {
        prompt: String(prompt),
        size,
        seed: typeof seed === 'number' ? seed : Number(seed ?? -1),
        guidance_scale: Number(guidance_scale ?? 2.5),
      },
      // DÔLEŽITÉ: watermark patrí do `extra`
      extra: { watermark },
      response_format,
    };

    const r = await axios.post(
      `${NOVITA_BASE_URL}/v3/seedream-3-0-txt2img`,
      payload,
      {
        headers: {
          Authorization: `Bearer ${NOVITA_API_KEY}`,
          'Content-Type': 'application/json',
        },
        timeout: 60000,
      }
    );

    const urls = r?.data?.image_urls || null;
    const b64s = r?.data?.binary_data_base64 || null;

    if (response_format === 'b64_json') {
      if (!Array.isArray(b64s) || !b64s.length) {
        return res.status(502).json({
          error: 'NO_IMAGE_DATA',
          detail: 'API nevrátilo binary_data_base64.',
        });
      }
      return res.json({ ok: true, format: 'b64_json', images: b64s });
    }

    // default 'url'
    if (!Array.isArray(urls) || !urls.length) {
      return res.status(502).json({
        error: 'NO_IMAGE_URLS',
        detail: 'API nevrátilo image_urls.',
      });
    }

    return res.json({ ok: true, format: 'url', images: urls });
  } catch (e) {
    const status = e?.status || e?.response?.status || 500;
    const details = e?.response?.data || e?.message || 'Unknown error';
    console.error('seedream-3-0-txt2img error:', status, details);
    return res.status(status).json({ error: 'SERVER_ERROR', details });
  }
});
