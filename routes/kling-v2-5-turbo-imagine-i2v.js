// routes/kling-v2-5-turbo-imagine-i2v.js
import { Router } from "express";
import multer from "multer";

const NOVITA_BASE = "https://api.novita.ai";
const router = Router();

// limit 10 MB podľa Novita API
const upload = multer({ limits: { fileSize: 10 * 1024 * 1024 } });

function mustEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

// === helper: vytvorenie úlohy (Image → Video)
async function createKlingV25ImagineJob(payload) {
  const r = await fetch(`${NOVITA_BASE}/v3/async/kling-2.5-turbo-i2v`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${mustEnv("NOVITA_API_KEY")}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });
  if (!r.ok) {
    const text = await r.text();
    throw new Error(`Kling I2V error ${r.status}: ${text}`);
  }
  return r.json(); // { task_id }
}

// === helper: ziskanie výsledku podľa task_id
async function getTaskResult(taskId) {
  const url = new URL(`${NOVITA_BASE}/v3/async/task-result`);
  url.searchParams.set("task_id", taskId);
  const r = await fetch(url, {
    headers: {
      Authorization: `Bearer ${mustEnv("NOVITA_API_KEY")}`,
    },
  });
  if (!r.ok) {
    const text = await r.text();
    throw new Error(`Task Result error ${r.status}: ${text}`);
  }
  return r.json(); // { task: {...}, videos: [...] }
}

// === POST /api/kling-v2-5-turbo-imagine-i2v
router.post(
  "/kling-v2-5-turbo-imagine-i2v",
  upload.single("image"),
  async (req, res) => {
    try {
      const {
        prompt,
        duration = "5",            // "5" | "10"
        cfg_scale = 0.5,           // 0..1
        mode = "pro",              // "pro"
        negative_prompt = "",
        image_base64,
        image_url,
      } = req.body || {};

      if (!prompt) {
        return res.status(400).json({ error: "Missing 'prompt'" });
      }

      // vstupný obrázok: base64 > url > file
      let image;
      if (image_base64) {
        image = image_base64;
      } else if (image_url) {
        image = image_url;
      } else if (req.file) {
        const mime = req.file.mimetype || "image/jpeg";
        const b64 = req.file.buffer.toString("base64");
        image = `data:${mime};base64,${b64}`;
      } else {
        return res.status(400).json({ error: "Missing image (file/base64/url)" });
      }

      const payload = {
        image,
        prompt,
        duration,
        cfg_scale: Number(cfg_scale),
        mode,
        negative_prompt,
      };

      const { task_id } = await createKlingV25ImagineJob(payload);
      return res.json({ task_id });
    } catch (err) {
      console.error("❌ Error in imagine route:", err);
      return res.status(500).json({ error: String(err.message || err) });
    }
  }
);

// === GET /api/kling-v2-5-turbo-imagine-i2v/task/:id
router.get("/kling-v2-5-turbo-imagine-i2v/task/:id", async (req, res) => {
  try {
    const data = await getTaskResult(req.params.id);
    return res.json(data);
  } catch (err) {
    console.error("❌ Task result error:", err);
    return res.status(500).json({ error: String(err.message || err) });
  }
});

export default router;
