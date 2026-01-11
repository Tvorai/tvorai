/**
 * Route: Kling V2.5 Turbo Text to Video (T2V)
 * API: /api/kling/v2-5/t2v
 */

import express from 'express';
import axios from 'axios';
import AWS from 'aws-sdk';

const router = express.Router();

const NOVITA_API_KEY = process.env.NOVITA_API_KEY;
const NOVITA_BASE_URL = process.env.NOVITA_BASE_URL || 'https://api.novita.ai';

// AWS S3
const S3 = new AWS.S3({
  region: process.env.AWS_REGION,
  accessKeyId: process.env.AWS_ACCESS_KEY,
  secretAccessKey: process.env.AWS_SECRET_KEY,
});
const AWS_BUCKET = process.env.AWS_BUCKET;

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

// === POST /generate ===
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

    if (Array.isArray(aspect_ratio)) {
      aspect_ratio = aspect_ratio[0];
    }

    aspect_ratio = String(aspect_ratio).trim();
    duration = String(duration).trim();

    if (!prompt || typeof prompt !== 'string' || !prompt.trim()) {
      return res.status(400).json({ error: "Missing or empty 'prompt'" });
    }

    const payload = {
      prompt: prompt.trim(),
      duration,
      aspect_ratio,
      ...(cfg_scale ? { cfg_scale: normalizeCfgScale(cfg_scale) } : {}),
      mode,
      ...(negative_prompt ? { negative_prompt } : {})
    };

    const response = await axios.post(`${NOVITA_BASE_URL}/v2/kling/turbo-text-to-video`, payload, {
      headers: {
        Authorization: `Bearer ${NOVITA_API_KEY}`,
        'Content-Type': 'application/json'
      }
    });

    return res.json({ ok: true, generationId: response.data?.generationId || null });
  } catch (err) {
    console.error('/generate error:', err.message);
    return res.status(500).json({ ok: false, error: 'Failed to generate video' });
  }
});

// === GET /status/:taskId ===
router.get('/status/:taskId', async (req, res) => {
  const taskId = req.params.taskId;

  try {
    const r = await axios.get(`${NOVITA_BASE_URL}/generation/${taskId}/status`, {
      headers: {
        Authorization: `Bearer ${NOVITA_API_KEY}`
      }
    });

    return res.json({ ok: true, status: r.data?.status, sourceUrl: r.data?.videoUrl });
  } catch (err) {
    console.error('/status error:', err.message);
    return res.status(500).json({ ok: false, error: 'Failed to fetch status' });
  }
});

// === GET /finalize/:taskId ===
async function fileExistsOnS3(key) {
  try {
    await S3.headObject({ Bucket: AWS_BUCKET, Key: key }).promise();
    return true;
  } catch (err) {
    if (err.code === 'NotFound') return false;
    throw err;
  }
}

router.get('/finalize/:taskId', async (req, res) => {
  const taskId = req.params.taskId;
  const s3Key = `videos/${taskId}.mp4`;
  const s3Url = `https://${AWS_BUCKET}.s3.amazonaws.com/${s3Key}`;

  try {
    const exists = await fileExistsOnS3(s3Key);
    if (exists) {
      return res.json({ ok: true, url: s3Url, cached: true });
    }

    const statusRes = await axios.get(`${NOVITA_BASE_URL}/generation/${taskId}/status`, {
      headers: { Authorization: `Bearer ${NOVITA_API_KEY}` }
    });

    const videoUrl = statusRes.data?.videoUrl;
    if (!videoUrl) return res.status(404).json({ ok: false, error: 'No video found for task' });

    const download = await axios.get(videoUrl, { responseType: 'stream' });

    await S3.upload({
      Bucket: AWS_BUCKET,
      Key: s3Key,
      Body: download.data,
      ContentType: 'video/mp4'
    }).promise();

    return res.json({ ok: true, url: s3Url, cached: false });
  } catch (err) {
    console.error('/finalize error:', err.message);
    return res.status(500).json({ ok: false, error: 'Finalize failed' });
  }
});

export default router;
