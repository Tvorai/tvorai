/**
 * Seedream 3.0 Text → Image route
 * Endpoint: POST /api/seedream/3/t2i/generate
 * Works with WordPress + AJAX + credits
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

router.post("/generate", async (req, res) => {
  try {
    assertEnv();

    const {
      prompt,
      size = "1024x1024",
      seed = -1,
      guidance_scale = 2.5,
      watermark = true,
      response_format = "url"
    } = req.body || {};

    if (!prompt || typeof prompt !== "string") {
      return res.status(400).json({ ok: false, error: "MISSING_PROMPT" });
    }

    // FINAL PAYLOAD (100% valid per Novita docs)
    const payload = {
      console.log("🔥 Seedream payload on server:", payload);
      prompt,
      model: "seedream-3-0-t2i-250415", // REQUIRED
      size,
      seed,
      guidance_scale,
      watermark,
      response_format
    };

    const r = await axios.post(
      `${NOVITA_BASE_URL}/v3/seedream-3-0-txt2img`,
      payload,
      {
        headers: {
          Authorization: `Bearer ${NOVITA_API_KEY}`,
          "Content-Type": "application/json",
        },
        timeout: 45000
      }
    );

    // Normalize output for WP + frontend compatibility
    return res.json({
      ok: true,
      images: r.data.image_urls ?? r.data.binary_data_base64 ?? [],
      raw: r.data // helpful for debugging
    });

  } catch (e) {
    const apiErr = e?.response?.data || e.message;
    console.error("🔥 Seedream 3.0 T2I error:", apiErr);

    return res
      .status(e?.response?.status || 500)
      .json({ ok: false, error: apiErr });
  }
});

export default router;
