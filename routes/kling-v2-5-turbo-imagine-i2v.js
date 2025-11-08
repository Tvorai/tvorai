/**
 * Route: Kling V2.5 Turbo Image → Video (I2V)
 * Mount v server.js: app.use('/api/kling/v2-5/i2v', i2vRouter)
 *
 * Endpoints (relatívne k mountu):
 *   POST /generate         → spustí generovanie, vráti { ok, generationId }
 *   GET  /status/:taskId   → stav, prípadne videoUrl
 */

import express from 'express';
import multer from 'multer';
import axios from 'axios';

const router = express.Router();

const NOVITA_API_KEY  = process.env.NOVITA_API_KEY;               // Render → Environment
const NOVITA_BASE_URL = process.env.NOVITA_BASE_URL || 'https://api.novita.ai';

// limit 10MB podľa Novita
const upload = multer({ limits: { fileSize: 10 * 1024 * 1024 } });

function assertEnv () {
  if (!NOVITA_API_KEY) {
    const err = new Error('NOVITA_API_KEY chýba v env (Render → Environment).');
    err.status = 500;
    throw err;
  }
}

function kB64Size (dataUrlOrB64) {
  // rough prepočet veľkosti base64 v bajtoch
  const s = (dataUrlOrB64 || '').toString();
  const i = s.indexOf('base64,');
  const b64 = i >= 0 ? s.slice(i + 7) : s;
  return Math.floor(b64.length * 0.75);
}

/**
 * POST /generate
 * Body (hocijaké z image_* je OK):
 * {
 *   image_base64?: "data:image/png;base64,...." | "<base64>",
 *   image_url?: "https://...",
 *   // alternatívne multipart pole "image" (upload súboru)
 *   prompt: string,
 *   duration?: "5" | "10" | 5 | 10,
 *   cfg_scale?: number [0..1],
 *   mode?: "pro",
 *   negative_prompt?: string
 * }
 *
 * Response: { ok:true, generationId: "<task_id>", status:"queued" }
 */
router.post('/generate', upload.single('image'), async (req, res) => {
  let image;
  try {
    assertEnv();

    const {
      prompt,
      duration = '5',
      cfg_scale,
      mode = 'pro',
      negative_prompt
      // aspect_ratio sa v Novita I2V neuvádza (ignorujeme)
    } = req.body || {};

    if (!prompt || typeof prompt !== 'string' || !prompt.trim()) {
      return res.status(400).json({ error: "Missing or empty 'prompt'." });
    }
    if (!['5', '10', 5, 10].includes(duration)) {
      return res.status(400).json({ error: "Invalid 'duration' (5|10)." });
    }
    if (typeof cfg_scale !== 'undefined') {
      const n = Number(cfg_scale);
      if (Number.isNaN(n) || n < 0 || n > 1) {
        return res.status(400).json({ error: "Invalid 'cfg_scale' (0..1)." });
      }
    }
    if (mode !== 'pro') {
      return res.status(400).json({ error: "Invalid 'mode' (only 'pro' supported)." });
    }

    // --- obrazový vstup: base64 > url > multipart
    const image_base64 = req.body?.image_base64;
    const image_url    = req.body?.image_url;

    if (image_base64) {
      if (kB64Size(image_base64) > 10 * 1024 * 1024) {
        return res.status(400).json({ error: 'IMAGE_TOO_LARGE' });
      }
      image = image_base64;
    } else if (image_url) {
      image = image_url;
    } else if (req.file) {
      const mime = req.file.mimetype || 'image/jpeg';
      const b64  = req.file.buffer.toString('base64');
      image = `data:${mime};base64,${b64}`;
    } else {
      return res.status(400).json({ error: 'Missing image (file/base64/url).' });
    }

    const payload = {
      image,
      prompt: String(prompt),
      duration: String(duration),     // "5" | "10"
      mode,
      ...(typeof cfg_scale !== 'undefined' ? { cfg_scale: Number(cfg_scale) } : {}),
      ...(negative_prompt ? { negative_prompt } : {})
    };

    const r = await axios.post(
      `${NOVITA_BASE_URL}/v3/async/kling-2.5-turbo-i2v`,
      payload,
      {
        headers: {
          Authorization: `Bearer ${NOVITA_API_KEY}`,
          'Content-Type': 'application/json'
        },
        timeout: 30000
      }
    );

    const taskId = r?.data?.task_id;
    if (!taskId) {
      return res.status(502).json({ error: 'NO_TASK_ID', details: 'API nevrátilo task_id.' });
    }
    return res.json({ ok: true, generationId: taskId, status: 'queued' });
  } catch (e) {
    const status = e?.status || e?.response?.status || 500;
    const details = e?.response?.data || e?.message || 'Unknown error';
    console.error('kling-v25-i2v generate error:', status, details);
    return res.status(status).json({ error: 'SERVER_ERROR', details });
  }
});

/**
 * GET /status/:taskId
 * Response:
 *  - { status: "in_progress", meta }
 *  - { status: "failed", reason, meta }
 *  - { status: "success", videoUrl, meta }
 */
router.get('/status/:taskId', async (req, res) => {
  try {
    assertEnv();

    const { taskId } = req.params;
    if (!taskId) return res.status(400).json({ error: 'Missing taskId.' });

    const r = await axios.get(`${NOVITA_BASE_URL}/v3/async/task-result`, {
      headers: { Authorization: `Bearer ${NOVITA_API_KEY}` },
      params:  { task_id: taskId },
      timeout: 20000
    });

    const task = r?.data?.task || {};
    const status = task.status;
    const progress = task.progress_percent ?? 0;
    const eta = task.eta ?? 0;
    const reason = task.reason || '';
    const meta = { progress, eta, taskId };

    if (status === 'TASK_STATUS_SUCCEED') {
      const firstVideo = Array.isArray(r?.data?.videos) ? r.data.videos[0] : null;
      const videoUrl   = firstVideo?.video_url || null;
      return res.json({ status: 'success', videoUrl, meta });
    }

    if (status === 'TASK_STATUS_FAILED') {
      return res.json({ status: 'failed', reason: reason || 'Model failed', meta });
    }

    return res.json({ status: 'in_progress', meta });
  } catch (e) {
    const status = e?.status || e?.response?.status || 500;
    const details = e?.response?.data || e?.message || 'Unknown error';
    console.error('kling-v25-i2v status error:', status, details);
    return res.status(status).json({ error: 'SERVER_ERROR', details });
  }
});

export default router;
