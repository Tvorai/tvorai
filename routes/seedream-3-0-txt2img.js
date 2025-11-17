/**
 * Seedream 3.0 — Text to Image (Final + Debug Version)
 * Fully compatible with:
 *   /api/seedream/3/t2i/generate      ← official
 *   /api/seedream-3-0-txt2img         ← legacy UI
 *   /api/seedream/txt2img             ← legacy UI
 */

import express from "express";
import axios from "axios";
import { randomUUID } from "crypto";

const router = express.Router();

// === ENV SANITIZATION + DEBUG =============================================
function sanitizeEnvUrl(raw) {
  if (!raw) return "";
  return raw
    .trim()                      // remove whitespace / newlines
    .replace(/[^\x20-\x7E]/g, "") // remove invisible Unicode (zero-width etc)
    .replace(/\/+$/, "");         // strip trailing slashes
}

const RAW_URL = process.env.NOVITA_BASE_URL;
const CLEAN_URL = sanitizeEnvUrl(RAW_URL);

// Debug output (IMPORTANT: this lets us SEE hidden characters)
console.log("🔎 ENV NOVITA_BASE_URL RAW:  ", JSON.stringify(RAW_URL));
console.log("🔎 ENV NOVITA_BASE_URL CLEAN:", JSON.stringify(CLEAN_URL));

// Final usable URL fallback
const NOVITA_BASE_URL = CLEAN_URL || "https://api.novita.ai";

const NOVITA_API_KEY = process.env.NOVITA_API_KEY;

// === ENV CHECK =============================================================
function assertEnv() {
  if (!NOVITA_API_KEY) {
    const err = new Error("NOVITA_API_KEY missing");
    err.status = 500;
    throw err;
  }
  if (!NOVITA_BASE_URL.startsWith("http")) {
    const err = new Error("NOVITA_BASE_URL looks invalid: " + NOVITA_BASE_URL);
    err.status = 500;
    throw err;
  }
}

// === ROUTE HANDLER ==========================================================
async function handleGenerate(req, res) {
  try {
    assertEnv();

    const {
      prompt,
      model = "seedream-3-0-t2i-250415",
      response_format = "url",
      size = "1024x1024",
      seed = -1,
      guidance_scale = 2.5,
      watermark: watermarkRaw = "off",
    } = req.body ?? {};

    if (!prompt || typeof prompt !== "string" || !prompt.trim()) {
      return res.status(400).json({ error: "Missing 'prompt'" });
    }

    const wmStr = String(watermarkRaw).trim().toLowerCase();
    const watermark =
      !(
        wmStr === "off" ||
        wmStr === "false" ||
        wmStr === "0" ||
        wmStr === "no"
      );

    const endpoint = `${NOVITA_BASE_URL}/v3/image/generations`;

    const payload = {
      model_name: model,
      request_id: randomUUID(),
      response_format,
      input: {
        prompt,
        size,
        seed,
        guidance_scale,
        watermark,
      },
    };

    // 🔎 DEBUG LOGGING
    console.log("📡 CALLING:", endpoint);
    console.log("➡️ PAYLOAD:", JSON.stringify(payload, null, 2));

    const r = await axios.post(endpoint, payload, {
      headers: {
        Authorization: `Bearer ${NOVITA_API_KEY}`,
        "Content-Type": "application/json",
      },
      timeout: 60000,
    });

    console.log("⬅️ Response:", JSON.stringify(r.data, null, 2));

    const entries = r?.data?.data;
    if (!Array.isArray(entries) || entries.length === 0) {
      return res.status(502).json({
        ok: false,
        error: "NO_IMAGE_DATA",
        raw: r.data,
        code: 502
      });
    }

    const urls = entries.map((x) => x.image_url).filter(Boolean);
    const b64s = entries.map((x) => x.b64_json).filter(Boolean);

    if (response_format === "b64_json") {
      if (!b64s.length) {
        return res.status(502).json({ ok: false, error: "NO_B64", code: 502 });
      }
      return res.json({ ok: true, format: "b64_json", images: b64s });
    }

    if (!urls.length) {
      return res.status(502).json({ ok: false, error: "NO_URLS", code: 502 });
    }

    return res.json({ ok: true, format: "url", images: urls });

  } catch (e) {
    console.error("❌ seedream-3-0-txt2img error:", e?.response?.status || e?.status || 500, e?.response?.data || e?.message);
    return res.status(e?.status || e?.response?.status || 500).json({
      ok: false,
      error: "SERVER_ERROR",
      raw: e?.response?.data || e?.message,
      code: e?.response?.status || 500,
    });
  }
}

// === ROUTE MAPPINGS =========================================================
router.post("/", handleGenerate);        // legacy
router.post("/generate", handleGenerate); // official

export default router;
