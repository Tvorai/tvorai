/**
 * Route: Kling V2.5 Turbo Image → Video (I2V)
 * Mount v server.js: app.use('/api/kling/v2-5/i2v', i2vRouter)
 */

import express from 'express';
import multer from 'multer';
import axios from 'axios';
import AWS from 'aws-sdk';   // 🔥 doplnené – AWS S3 upload

const router = express.Router();

const NOVITA_API_KEY  = process.env.NOVITA_API_KEY;
const NOVITA_BASE_URL = process.env.NOVITA_BASE_URL || 'https://api.novita.ai';

// === AWS S3 (rovnako ako merge-face) ===
const S3 = new AWS.S3({
  region: process.env.AWS_REGION,
  accessKeyId: process.env.AWS_ACCESS_KEY,
  secretAccessKey: process.env.AWS_SECRET_KEY,
});
const AWS_BUCKET = process.env.AWS_BUCKET;

// limit 10MB podľa Novita
const upload = multer({ limits: { fileSize: 10 * 1024 * 1024 } });

function assertEnv () {
  if (!NOVITA_API_KEY) throw new Error('NOVITA_API_KEY missing');

  // 🔥 doplnené AWS kontroly
  if (!process.env.AWS_REGION)     throw new Error("AWS_REGION missing");
  if (!process.env.AWS_ACCESS_KEY) throw new Error("AWS_ACCESS_KEY missing");
  if (!process.env.AWS_SECRET_KEY) throw new Error("AWS_SECRET_KEY missing");
  if (!process.env.AWS_BUCKET)     throw new Error("AWS_BUCKET missing");
}

function kB64Size (dataUrlOrB64) {
  const s = (dataUrlOrB64 || '').toString();
  const i = s.indexOf('base64,');
  const b64 = i >= 0 ? s.slice(i + 7) : s;
  return Math.floor(b64.length * 0.75);
}

/**
 * POST /generate
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
    } = req.body || {};

    if (!prompt?.trim()) {
      return res.status(400).json({ error: "Missing or empty 'prompt'." });
    }
    if (!['5', '10', 5, 10].includes(duration)) {
      return res.status(400).json({ error: "Invalid 'duration' (5|10)." });
    }
    if (cfg_scale !== undefined) {
      const n = Number(cfg_scale);
      if (isNaN(n) || n < 0 || n > 1) {
        return res.status(400).json({ error: "Invalid 'cfg_scale' (0..1)." });
      }
    }
    if (mode !== 'pro') {
      return res.status(400).json({ error: "Invalid 'mode' (only 'pro')." });
    }

    // --- vstupný obrázok ---
    const image_base64 = req.body?.image_base64;
    const image_url    = req.body?.image_url;

    if (image_base64) {
      if (kB64Size(image_base64) > 10 * 1024 * 1024) {
        return res.status(400).json({ error: 'IMAGE_TOO_LARGE' });
      }
      image = image_base64;
    }
    else if (image_url) {
      image = image_url;
    }
    else if (req.file) {
      const mime = req.file.mimetype || 'image/jpeg';
      const b64  = req.file.buffer.toString('base64');
      image = `data:${mime};base64,${b64}`;
    }
    else {
      return res.status(400).json({ error: 'Missing image (file/base64/url).' });
    }

    const payload = {
      image,
      prompt: String(prompt),
      duration: String(duration),
      mode,
      ...(cfg_scale !== undefined ? { cfg_scale: Number(cfg_scale) } : {}),
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
      return res.status(502).json({ error: 'NO_TASK_ID', details: 'Novita nevrátila task_id' });
    }
    return res.json({ ok: true, generationId: taskId, status: 'queued' });

  } catch (e) {
    console.error('kling-v25-i2v generate error:', e);
    const status = e?.status || e?.response?.status || 500;
    const details = e?.response?.data || e.message;
    return res.status(status).json({ error: 'SERVER_ERROR', details });
  }
});

/**
 * GET /status/:taskId
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

      if (!videoUrl) {
        return res.json({ status: 'failed', reason: 'NO_VIDEO_URL', meta });
      }

      // === 🔥 AWS S3 upload (rovnaké ako merge-face) ===
      const videoResp = await axios.get(videoUrl, { responseType: 'arraybuffer' });
      const buffer = Buffer.from(videoResp.data);

      const fileName = `kling-i2v_${Date.now()}.mp4`;

      const uploaded = await S3.upload({
        Bucket: AWS_BUCKET,
        Key: fileName,
        Body: buffer,
        ContentType: 'video/mp4',
        ACL: 'public-read'
      }).promise();

      return res.json({
        status: 'success',
        videoUrl: uploaded.Location,   // 🔥 teraz používaš S3 URL (rovnako ako merge-face)
        meta
      });
    }

    if (status === 'TASK_STATUS_FAILED') {
      return res.json({ status: 'failed', reason, meta });
    }

    return res.json({ status: 'in_progress', meta });

  } catch (e) {
    console.error('kling-v25-i2v status error:', e);
    const status = e?.status || e?.response?.status || 500;
    const details = e?.response?.data || e?.message || 'Unknown error';
    return res.status(status).json({ error: 'SERVER_ERROR', details });
  }
});

export default router;
