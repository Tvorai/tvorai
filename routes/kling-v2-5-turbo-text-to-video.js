/**
 * Route: Kling V2.5 Turbo Text to Video
 * Endpoints:
 *  POST /api/kling-v25-t2v/generate  → vytvorí task a vráti task_id
 *  GET  /api/kling-v25-t2v/status/:taskId → zistí stav a prípadne vráti videoUrl
 */

import express from "express";
import axios from "axios";

const router = express.Router();

const NOVITA_API_KEY  = process.env.NOVITA_API_KEY; // Render → Environment
const NOVITA_BASE_URL = process.env.NOVITA_BASE_URL || "https://api.novita.ai";

/**
 * Utils
 */
function assertEnv() {
  if (!NOVITA_API_KEY) {
    const msg = "NOVITA_API_KEY chýba v env (Render → Environment).";
    const err = new Error(msg);
    err.status = 500;
    throw err;
  }
}

function normalizeCfgScale(val) {
  if (typeof val === "number") return val;
  if (typeof val === "string" && val.trim() !== "") return Number(val);
  return undefined; // necháme na default 0.5
}

/**
 * POST /api/kling-v25-t2v/generate
 * Body:
 * {
 *   prompt: string (req),
 *   duration?: "5" | "10" | 5 | 10 (default "5")
 *   aspect_ratio?: "16:9" | "9:16" | "1:1" (default "16:9")
 *   cfg_scale?: number 0..1 (default 0.5 na API strane)
 *   mode?: "pro" (default "pro")
 *   negative_prompt?: string
 * }
 *
 * Response:
 * { ok: true, generationId: "<task_id>", status: "queued" }
 */
router.post("/kling-v25-t2v/generate", async (req, res) => {
  try {
    assertEnv();

    const {
      prompt,
      duration = "5",
      aspect_ratio = "16:9",
      cfg_scale,
      mode = "pro",
      negative_prompt
    } = req.body || {};

    if (!prompt || typeof prompt !== "string" || !prompt.trim()) {
      return res.status(400).json({ error: "Missing or empty 'prompt'." });
    }

    const allowedDur = new Set(["5", "10", 5, 10]);
    const allowedAR  = new Set(["16:9", "9:16", "1:1"]);
    if (!allowedDur.has(duration)) {
      return res.status(400).json({ error: "Invalid 'duration' (allowed: 5, 10)." });
    }
    if (!allowedAR.has(aspect_ratio)) {
      return res.status(400).json({ error: "Invalid 'aspect_ratio' (allowed: 16:9, 9:16, 1:1)." });
    }
    if (mode !== "pro") {
      return res.status(400).json({ error: "Invalid 'mode' (only 'pro' supported)." });
    }

    const cfg = normalizeCfgScale(cfg_scale);
    if (typeof cfg !== "undefined" && (Number.isNaN(cfg) || cfg < 0 || cfg > 1)) {
      return res.status(400).json({ error: "Invalid 'cfg_scale' (0..1)." });
    }

    const payload = {
      prompt: String(prompt),
      duration: String(duration),
      aspect_ratio,
      mode,
      ...(typeof cfg === "number" ? { cfg_scale: cfg } : {}),
      ...(negative_prompt ? { negative_prompt } : {})
    };

    const r = await axios.post(
      `${NOVITA_BASE_URL}/v3/async/kling-2.5-turbo-t2v`,
      payload,
      {
        headers: {
          Authorization: `Bearer ${NOVITA_API_KEY}`,
          "Content-Type": "application/json"
        },
        timeout: 30000
      }
    );

    const taskId = r?.data?.task_id;
    if (!taskId) {
      return res.status(502).json({ error: "NO_TASK_ID", details: "API nevrátilo task_id." });
    }

    return res.json({ ok: true, generationId: taskId, status: "queued" });
  } catch (e) {
    const status = e?.status || e?.response?.status || 500;
    const detail = e?.response?.data || e?.message || "Unknown error";
    console.error("kling-v25-t2v generate error:", status, detail);
    return res.status(status).json({ error: "SERVER_ERROR", details: detail });
  }
});

/**
 * GET /api/kling-v25-t2v/status/:taskId
 * Poll Task Result API
 *
 * Response:
 *  - { status: "in_progress", meta }
 *  - { status: "failed", reason, meta }
 *  - { status: "success", videoUrl, meta }
 */
router.get("/kling-v25-t2v/status/:taskId", async (req, res) => {
  try {
    assertEnv();

    const { taskId } = req.params;
    if (!taskId) return res.status(400).json({ error: "Missing taskId." });

    const r = await axios.get(`${NOVITA_BASE_URL}/v3/async/task-result`, {
      headers: { Authorization: `Bearer ${NOVITA_API_KEY}` },
      params: { task_id: taskId },
      timeout: 20000
    });

    const task = r?.data?.task || {};
    const status = task.status;
    const progress = task.progress_percent ?? 0;
    const eta = task.eta ?? 0;
    const reason = task.reason || "";
    const meta = { progress, eta, taskId };

    if (status === "TASK_STATUS_SUCCEED") {
      const firstVideo = Array.isArray(r?.data?.videos) ? r.data.videos[0] : null;
      const videoUrl = firstVideo?.video_url || null;
      return res.json({ status: "success", videoUrl, meta });
    }

    if (status === "TASK_STATUS_FAILED") {
      return res.json({ status: "failed", reason: reason || "Model failed", meta });
    }

    return res.json({ status: "in_progress", meta });
  } catch (e) {
    const status = e?.status || e?.response?.status || 500;
    const detail = e?.response?.data || e?.message || "Unknown error";
    console.error("kling-v25-t2v status error:", status, detail);
    return res.status(status).json({ error: "SERVER_ERROR", details: detail });
  }
});

export default router;
