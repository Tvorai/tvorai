/**
 * Route: Seedream 3.0 — Text to Image (FIXED + FUTURE-PROOF)
 * Endpoint: POST /api/seedream/3/t2i/generate
 */

import express from "express";
import axios from "axios";

const router = express.Router();
export default router;

// === ENV ===
const NOVITA_API_KEY  = process.env.NOVITA_API_KEY;
const NOVITA_BASE_URL = process.env.NOVITA_BASE_URL || "https://api.novita.ai";

function assertEnv() {
  if (!NOVITA_API_KEY) {
    const err = new Error("NOVITA_API_KEY missing in environment.");
    err.status = 500;
    throw err;
  }
}

// === CLEAN WATERMARK PARSING ===
function normalizeWm(value) {
  const v = String(value ?? "").trim().toLowerCase();
  return !(v === "off" || v === "false" || v === "0" || v === "no" || v === "");
}

// === ROUTE ===
router.post("/generate", async (req, res) => {
  try {
    assertEnv();

    // === INPUT ===
    const {
      prompt,
      model,
      response_format = "url",
      size = "1024x1024",
      seed = -1,
      guidance_scale = 2.5,
      watermark = "off",
    } = req.body || {};

    if (!prompt || !String(prompt).trim()) {
      return res.status(400).json({ error: "Missing prompt" });
    }

    // validate size
    if (!/^\d{3,4}x\d{3,4}$/.test(size)) {
      return res.status(400).json({ error: "Invalid size (1024x1024 etc)" });
    }

    // === REALLY IMPORTANT: AUTO MODEL ===
    const finalModel = model || "seedream-3-0-t2i"; // dynamically resolves latest version

    // === Payload ===
    const payload = {
      prompt: String(prompt),
      model: finalModel,
      response_format,
      size,
      seed: Number(seed),
      guidance_scale: Number(guidance_scale),
      watermark: normalizeWm(watermark),
      extra: { watermark: normalizeWm(watermark) },
    };

    // === CALL NOVITA ===
    const r = await axios.post(
      `${NOVITA_BASE_URL}/v3/seedream-3-0-t2i`,
      payload,
      {
        headers: {
          Authorization: `Bearer ${NOVITA_API_KEY}`,
          "Content-Type": "application/json",
        },
        timeout: 65000,
      }
    );

    // === Handle Response ===
    const urls = r?.data?.image_urls;
    const b64s = r?.data?.binary_data_base64;

    if (response_format === "b64_json") {
      if (!Array.isArray(b64s) || !b64s.length) {
        return res.status(502).json({ error: "NO_B64_DATA", raw: r.data });
      }
      return res.json({ ok: true, format: "b64_json", images: b64s });
    }

    if (!Array.isArray(urls) || !urls.length) {
      return res.status(502).json({ error: "NO_IMAGE_URLS", raw: r.data });
    }

    return res.json({
      ok: true,
      format: "url",
      images: urls,
    });
  } catch (e) {
    const status = e?.status || e?.response?.status || 500;
    const details = e?.response?.data || e.message || "Unknown error";

    console.error("Seedream ERROR:", status, details);
    return res.status(status).json({
      ok: false,
      error: "SEEDREAM_SERVER_ERROR",
      status,
      details,
    });
  }
});
