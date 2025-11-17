/**
 * Seedream 4.0 Text → Image route
 * Endpoint: POST /api/seedream/4/t2i/generate
 * Text-only (prompt), voliteľne podporí aj image-to-image (images[])
 */

import express from "express";
import axios from "axios";

const router = express.Router();

const NOVITA_API_KEY = process.env.NOVITA_API_KEY;
const NOVITA_BASE_URL = process.env.NOVITA_BASE_URL || "https://api.novita.ai";

function assertEnv() {
  if (!NOVITA_API_KEY) {
    const err = new Error("NOVITA_API_KEY missing");
    err.status = 500;
    throw err;
  }
}

/**
 * POST /generate
 * Body:
 *  {
 *    prompt: string (required),
 *    images?: string[] (URL alebo base64),
 *    size?: "1K" | "2K" | "4K" | "2048x2048" | "2560x1440" | ...
 *    sequential_image_generation?: "auto" | "disabled" (default "disabled"),
 *    max_images?: number (1–15, použije sa len pri "auto"),
 *    watermark?: boolean (default true)
 *  }
 */
router.post("/generate", async (req, res) => {
  try {
    assertEnv();

    const {
  prompt,
  images,
  size,
  sequential_image_generation = "disabled",
  max_images = 1,
  watermark = false, // default bez watermarku
} = req.body || {};

    if (!prompt || typeof prompt !== "string" || !prompt.trim()) {
      return res.status(400).json({ ok: false, error: "MISSING_PROMPT" });
    }

    const payload = {
      prompt: String(prompt),
      ...(Array.isArray(images) && images.length > 0 ? { images } : {}),
      ...(size ? { size } : {}), // môžeš poslať "1K", "2K", "4K" alebo custom "2048x2048"
      sequential_image_generation,
      max_images,
      watermark,
    };

    // Debug (ak treba):
    // console.log("➡️ Seedream 4.0 payload:", payload);

    const r = await axios.post(
      `${NOVITA_BASE_URL}/v3/seedream-4.0`,
      payload,
      {
        headers: {
          Authorization: `Bearer ${NOVITA_API_KEY}`,
          "Content-Type": "application/json",
        },
        timeout: 60000,
      }
    );

    // API vráti { images: [ "https://..." ] }
    const imagesOut = Array.isArray(r.data?.images) ? r.data.images : [];

    return res.json({
      ok: true,
      images: imagesOut,
      raw: r.data, // necháš si to zatiaľ pre debug
    });
  } catch (e) {
    const status = e?.response?.status || 500;
    const apiErr = e?.response?.data || e.message;
    console.error("🔥 Seedream 4.0 T2I error:", apiErr);

    return res.status(status).json({
      ok: false,
      error: apiErr,
    });
  }
});

export default router;
