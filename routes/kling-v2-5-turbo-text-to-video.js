/**
 * Route: Kling V2.5 Turbo Text to Video
 * Mount v server.js: app.use('/api/kling/v2-5/t2v', t2vRouter)
 */

import express from 'express';
import axios from 'axios';
import AWS from 'aws-sdk';

const router = express.Router();

const NOVITA_API_KEY  = process.env.NOVITA_API_KEY;
const NOVITA_BASE_URL = process.env.NOVITA_BASE_URL || 'https://api.novita.ai';

// === AWS S3 ===
const S3 = new AWS.S3({
  region: process.env.AWS_REGION,
  accessKeyId: process.env.AWS_ACCESS_KEY,
  secretAccessKey: process.env.AWS_SECRET_KEY,
});

const AWS_BUCKET = process.env.AWS_BUCKET;

/* Helpers */
function assertEnv() {
  if (!NOVITA_API_KEY) throw new Error('NOVITA_API_KEY missing');
  if (!process.env.AWS_REGION) throw new Error('AWS_REGION missing');
  if (!process.env.AWS_ACCESS_KEY) throw new Error('AWS_ACCESS_KEY missing');
  if (!process.env.AWS_SECRET_KEY) throw new Error('AWS_SECRET_KEY missing');
  if (!AWS_BUCKET) throw new Error('AWS_BUCKET missing');
}

function normalizeCfgScale(val) {
  if (typeof val === 'number') return val;
  if (typeof val === 'string' && val.trim() !== '') return Number(val);
  return undefined;
}

/**
 * POST /generate
 */
router.post('/generate', async (req, res) => {
  try {
    assertEnv();

    let {
  prompt,
  duration = '5',
  aspect_ratio = '16:9',
  cfg_scale,
  mode = 'pro',
  negative_prompt
} = req.body || {};

// FIX: WP môže poslať array (aspect_ratio[])
if (Array.isArray(aspect_ratio)) {
    aspect_ratio = aspect_ratio[0];
}

aspect_ratio = String(aspect_ratio).trim();


if (aspect_ratio.startsWith(':')) {
    aspect_ratio = aspect_ratio.substring(1);
}

    // 🔥 NORMALIZÁCIA DURATION (rovnako môže prísť ako number)
    duration = String(duration).trim();

    // Validate prompt
    if (!prompt || typeof prompt !== 'string' || !prompt.trim()) {
      return res.status(400).json({ error: "Missing or empty 'prompt'." });
    }

    // Allowed values
    const allowedDur = new Set(['5', '10']);
    const allowedAR  = new Set(['16:9', '9:16', '1:1']);

    if (!allowedDur.has(duration)) {
      return res.status(400).json({ error: "Invalid duration (5|10)." });
    }

    if (!allowedAR.has(aspect_ratio)) {
      return res.status(400).json({ error: "Invalid aspect_ratio." });
    }

    if (mode !== 'pro') {
      return res.status(400).json({ error: "Invalid mode (only pro)." });
    }

    // CFG scale validation
    const cfg = normalizeCfgScale(cfg_scale);
    if (typeof cfg !== 'undefined' && (Number.isNaN(cfg) || cfg < 0 || cfg > 1)) {
      return res.status(400).json({ error: "Invalid cfg_scale (0..1)." });
    }

    // Payload to Novita API
    const payload = {
      prompt: String(prompt),
      duration,
      aspect_ratio,
      mode,
      ...(typeof cfg === 'number' ? { cfg_scale: cfg } : {}),
      ...(negative_prompt ? { negative_prompt } : {})
    };

    console.log(">>> PAYLOAD SENT TO NOVITA:", payload);

    // API CALL
    const r = await axios.post(
      `${NOVITA_BASE_URL}/v3/async/kling-2.5-turbo-t2v`,
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
      return res.status(502).json({ error: 'NO_TASK_ID' });
    }

    return res.json({ ok: true, generationId: taskId, status: 'queued' });

  } catch (e) {
    const status = e?.status || e?.response?.status || 500;
    const detail = e?.response?.data || e?.message || 'Unknown error';
    console.error('kling generate error:', status, detail);
    return res.status(status).json({ error: 'SERVER_ERROR', details: detail });
  }
});

/**
 * GET /status/:taskId
 */
router.get('/status/:taskId', async (req, res) => {
  try {
    assertEnv();

    const { taskId } = req.params;
    if (!taskId) return res.status(400).json({ error: 'Missing taskId' });

    const r = await axios.get(`${NOVITA_BASE_URL}/v3/async/task-result`, {
      headers: { Authorization: `Bearer ${NOVITA_API_KEY}` },
      params: { task_id: taskId },
      timeout: 20000
    });

    const task = r?.data?.task || {};
    const status = task.status;

    const meta = {
      progress: task.progress_percent ?? 0,
      eta: task.eta ?? 0,
      taskId
    };

    if (status !== 'TASK_STATUS_SUCCEED' && status !== 'TASK_STATUS_FAILED') {
      return res.json({ status: 'in_progress', meta });
    }

    if (status === 'TASK_STATUS_FAILED') {
      return res.json({ status: 'failed', reason: task.reason || 'Model failed', meta });
    }

    const rawVideos = Array.isArray(r?.data?.videos) ? r.data.videos : [];
    let selected = rawVideos.find(v => v.is_final === true);
    if (!selected) selected = rawVideos[rawVideos.length - 1];

    const sourceUrl = selected?.video_url || null;
    if (!sourceUrl) {
      return res.status(502).json({ status: 'failed', reason: 'NO_VIDEO_URL', meta });
    }

    const videoRes = await axios.get(sourceUrl, {
      responseType: 'arraybuffer',
      timeout: 60000
    });

    const buffer = Buffer.from(videoRes.data);

    const key = `kling_v25_t2v_${taskId}_${Date.now()}.mp4`;

    const uploadRes = await S3.upload({
      Bucket: AWS_BUCKET,
      Key: key,
      Body: buffer,
      ContentType: 'video/mp4',
    }).promise();

    const s3Url = uploadRes.Location;

    // === SAVE HISTORY TO WORDPRESS ===
    try {
      await axios.post(
        process.env.WP_AJAX_URL,
        new URLSearchParams({
          action: 'ai_history_save_api',
          prompt: task?.prompt || 'Kling Turbo T2V',
          url: s3Url,
          type: 'kling_v25_t2v'
        }),
        { headers: { "Content-Type": "application/x-www-form-urlencoded" } }
      );
      console.log("✔ AI HISTORY uložené pre Kling T2V");
    } catch (err) {
      console.error("❌ AI HISTORY FAIL:", err.message);
    }

    return res.json({
      status: 'success',
      videoUrl: s3Url,
      meta
    });

  } catch (e) {
    const status = e?.status || e?.response?.status || 500;
    const detail = e?.response?.data || e?.message || 'Unknown error';
    console.error('kling status error:', status, detail);
    return res.status(status).json({ error: 'SERVER_ERROR', details: detail });
  }
});

export default router;
