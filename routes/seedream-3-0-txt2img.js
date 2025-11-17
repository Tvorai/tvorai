/**
 * Route: Seedream 3.0 — Text to Image
 * Mount: app.use('/api/seedream/3/t2i', router)
 *
 * Endpoint:
 *  POST /generate → returns image urls or base64
 */

import express from "express";
import axios from "axios";
import { randomUUID } from "crypto";

const router = express.Router();
export default router;

const NOVITA_API_KEY = process.env.NOVITA_API_KEY;
const NOVITA_BASE_URL = (process.env.NOVITA_BASE_URL || "https://api.novita.ai")
  .trim()
  .replace(/\/+$/, ""); // remove trailing slash

function assertEnv() {
  if (!NOVITA_API_KEY) {
    const err = new Error("NOVITA_API_KEY missing in ENV");
    err.status = 500;
    throw err;
  }
}

// === POST /generate ==========================================================
router.post("/generate", async (req, res) => {
  try {
    assertEnv();

    const {
      prompt,
      model = "seedream-3-0-t2i-250415",
      response_format = "url", // 'url' | 'b64_json'
      size = "1024x1024",
      seed = -1,
      guidance_scale = 2.5,
      watermark: watermarkRaw = "off",
    } = req.body || {};

    if (!prompt || typeof prompt !== "string" || !prompt.trim()) {
      return res.status(400).json({ error: "Missing or empty 'prompt'." });
    }

    const sizeRe = /^(\d{3,4})x(\d{3,4})$/;
    if (!sizeRe.test(size)) {
      return res.status(400).json({ error: "Invalid 'size' format (e.g. 1024x1024)" });
    }

    // boolean watermark parsing
    const wmStr = String(watermarkRaw).trim().toLowerCase();
    const watermark =
      !(
        wmStr === "off" ||
        wmStr === "false" ||
        wmStr === "0" ||
        wmStr === "no"
      );

    // === PAYLOAD (FINAL AND CORRECT) ===
    const payload = {
      model_name: model,               // ✔ correct key
      request_id: randomUUID(),        // ✔ required
      response_format,
      input: {
        prompt: String(prompt),
        size,
        seed: Number(seed ?? -1),
        guidance_scale: Number(guidance_scale ?? 2.5),
        watermark,
      },
    };

    console.log("➡️ Sending to Novita:", JSON.stringify(payload, null, 2));

    const r = await axios.post(
      `${NOVITA_BASE_URL}/v3/image/generations`,
      payload,
      {
        headers: {
          Authorization: `Bearer ${NOVITA_API_KEY}`,
          "Content-Type": "application/json",
        },
        timeout: 60000,
      }
    );

    console.log("⬅️ Novita raw response:", JSON.stringify(r.data, null, 2));

    // === HANDLE RESPONSE ===
    const entries = r?.data?.data;
    if (!Array.isArray(entries) || entries.length === 0) {
      return res.status(502).json({
        error: "NO_RESULTS",
        detail: "API returned no data",
        raw: r.data
      });
    }

    const urls = entries
      .map((x) => x.image_url || null)
      .filter(Boolean);

    const b64s = entries
      .map((x) => x.b64_json || null)
      .filter(Boolean);

    if (response_format === "b64_json") {
      if (!b64s.length) {
        return res.status(502).json({ error: "NO_IMAGE_DATA", detail: "No b64_json returned" });
      }
      return res.json({ ok: true, format: "b64_json", images: b64s });
    }

    // default: URL mode
    if (!urls.length) {
      return res.status(502).json({ error: "NO_IMAGE_URLS", detail: "No image_url returned" });
    }

    return res.json({ ok: true, format: "url", images: urls });

  } catch (e) {
    const status = e?.status || e?.response?.status || 500;
    const details = e?.response?.data || e?.message || "Unknown error";
    console.error("seedream-3-0-txt2img error:", status, details);
    return res.status(status).json({ error: "SERVER_ERROR", details });
  }
});
