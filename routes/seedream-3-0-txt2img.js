/**
 * Route: Seedream 3.0 Text → Image
 * Mount v server.js:
 *  app.use('/api/seedream/3/t2i', seedreamRouter)
 *
 * Endpoints:
 *  POST /generate  → vráti image_url alebo base64 podľa response_format
 */

import express from 'express';
import axios from 'axios';

const router = express.Router();

const NOVITA_API_KEY  = process.env.NOVITA_API_KEY;
const NOVITA_BASE_URL = process.env.NOVITA_BASE_URL || 'https://api.novita.ai';

function assertEnv() {
  if (!NOVITA_API_KEY) {
    const err = new Error('❌ NOVITA_API_KEY chýba v ENV!');
    err.status = 500;
    throw err;
  }
}

router.post('/generate', async (req, res) => {
  try {
    assertEnv();

    const {
      prompt,
      size = "1024x1024",
      guidance_scale = 2.5,
      seed = -1,
      response_format = "url",
      watermark = true
    } = req.body || {};

    if (!prompt || typeof prompt !== "string") {
      return res.status(400).json({ error: "Missing 'prompt'!" });
    }

    const payload = {
      prompt,
      model: "seedream-3-0-t2i-250415",
      size,
      guidance_scale,
      seed,
      watermark,
      response_format
    };

    const r = await axios.post(
      `${NOVITA_BASE_URL}/v3/seedream-3-0-txt2img`,
      payload,
      {
        headers: {
          Authorization: `Bearer ${NOVITA_API_KEY}`,
          "Content-Type": "application/json",
        },
        timeout: 40000
      }
    );

    return res.json({
      ok: true,
      ...r.data
    });

  } catch (e) {
    console.error("Seedream T2I error:", e?.response?.data || e.message);

    return res.status(e?.response?.status || 500).json({
      ok: false,
      error: e?.response?.data || e.message
    });
  }
});

export default router;
