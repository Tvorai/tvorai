/**
 * Seedream 3.0 – FULL WORKING VERSION
 * === CREATE TASK + POLLING ===
 */

import express from "express";
import axios from "axios";

const router = express.Router();
export default router;

const API = process.env.NOVITA_BASE_URL || "https://api.novita.ai";
const KEY = process.env.NOVITA_API_KEY;

function w(x) {
  const v = String(x ?? "").toLowerCase();
  return !(v === "off" || v === "false" || v === "0" || v === "no");
}

router.post("/generate", async (req, res) => {
  try {
    if (!KEY) throw new Error("Missing NOVITA_API_KEY");

    const {
      prompt,
      size = "1024x1024",
      seed = -1,
      guidance_scale = 2.5,
      watermark = "off",
    } = req.body ?? {};

    if (!prompt) return res.status(400).json({ error: "NO_PROMPT" });

    // 1️⃣ CREATE TASK
    const create = await axios.post(
      `${API}/v3/seedream-3-0-t2i`,
      {
        model: "seedream-3-0-t2i",
        prompt,
        size,
        seed,
        guidance_scale,
        watermark: w(watermark),
      },
      {
        headers: { Authorization: `Bearer ${KEY}` },
        timeout: 20000,
      }
    );

    const taskId = create?.data?.task_id;
    if (!taskId) throw new Error("NO_TASK_ID");

    console.log("🎯 Seedream task:", taskId);

    // 2️⃣ POLLING
    let tries = 0;
    let img = null;

    while (tries < 25) {
      await new Promise((r) => setTimeout(r, 1200));
      tries++;

      const poll = await axios.get(`${API}/v3/tasks/${taskId}`, {
        headers: { Authorization: `Bearer ${KEY}` },
      });

      if (poll?.data?.status === "success") {
        img = poll?.data?.image_urls?.[0];
        break;
      }

      if (poll?.data?.status === "failed") throw new Error("TASK_FAILED");
    }

    if (!img) throw new Error("TIMEOUT");

    return res.json({
      ok: true,
      image: img,
    });
  } catch (e) {
    console.log("❌ SEEDREAM ERROR:", e?.response?.data || e.message);
    res.status(500).json({
      ok: false,
      error: e.message,
      raw: e?.response?.data,
    });
  }
});
