import express from 'express';
import axios from 'axios';

const router = express.Router();

const NOVITA_API_KEY  = process.env.NOVITA_API_KEY;
const NOVITA_BASE_URL = process.env.NOVITA_BASE_URL || 'https://api.novita.ai';

function assertEnv() {
  if (!NOVITA_API_KEY) {
    const err = new Error('NOVITA_API_KEY missing');
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
      response_format = "url",
      seed = -1,
      guidance_scale = 2.5,
      watermark = true
    } = req.body || {};

    if (!prompt) return res.status(400).json({ ok: false, error: "MISSING_PROMPT" });

    const payload = {
      prompt,
      model: "seedream-3-0-t2i-250415",    // ✅ REQUIRED
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
          'Content-Type': 'application/json'
        }
      }
    );

    return res.json({ ok: true, ...r.data });

  } catch (e) {
    const data = e?.response?.data || e?.message;
    console.error("Seedream T2I error:", data);
    return res.status(e?.response?.status || 500).json({ ok: false, error: data });
  }
});

export default router;
