import express from "express";
import fs from "fs";
import axios from "axios";
import AWS from "aws-sdk";

import { makeUploader } from "../core/includes/upload.js";
import { safeUnlink } from "../core/includes/safeUnlink.js";

const router = express.Router();
export default router;

const NOVITA_API_KEY  = process.env.NOVITA_API_KEY;
const NOVITA_BASE_URL = process.env.NOVITA_BASE_URL || "https://api.novita.ai";
const AWS_BUCKET = process.env.AWS_BUCKET;

function assertEnv() {
  if (!NOVITA_API_KEY) throw new Error("NOVITA_API_KEY missing");
  if (!AWS_BUCKET) throw new Error("AWS_BUCKET missing");
}

/* AWS */
const S3 = new AWS.S3({
  region: process.env.AWS_REGION,
  accessKeyId: process.env.AWS_ACCESS_KEY,
  secretAccessKey: process.env.AWS_SECRET_KEY,
});

/* upload (disk → /tmp) */
const upload = makeUploader(30 * 1024 * 1024);

router.post(
  "/generate",
  upload.fields([
    { name: "face_image", maxCount: 1 },
    { name: "image_file", maxCount: 1 },
  ]),
  async (req, res) => {
    let facePath, imagePath;

    try {
      assertEnv();

      const faceFile  = req.files?.face_image?.[0];
      const imageFile = req.files?.image_file?.[0];

      facePath  = faceFile?.path;
      imagePath = imageFile?.path;

      if (!facePath || !imagePath) {
        return res.status(400).json({ ok:false, error:"MISSING_IMAGES" });
      }

      /* === STREAM → BASE64 === */
      const faceB64  = fs.readFileSync(facePath, { encoding: "base64" });
      const imageB64 = fs.readFileSync(imagePath, { encoding: "base64" });

      const wmStr = String(req.body?.watermark ?? "off").toLowerCase();
      const watermark = !(wmStr === "off" || wmStr === "false" || wmStr === "0");

      /* === NOVITA JSON CALL === */
      const novitaRes = await axios.post(
        `${NOVITA_BASE_URL}/v3/merge_face`,
        {
          face_image: faceB64,
          image_file: imageB64,
          watermark: watermark,
        },
        {
          headers: {
            Authorization: `Bearer ${NOVITA_API_KEY}`,
            "Content-Type": "application/json",
          },
          timeout: 60000,
        }
      );

      const outB64  = novitaRes?.data?.image_file;
      const outType = novitaRes?.data?.image_type || "png";

      if (!outB64) {
        return res.status(502).json({ ok:false, error:"NO_IMAGE_FROM_NOVITA" });
      }

      /* === UPLOAD TO S3 === */
      const buffer = Buffer.from(outB64, "base64");
      const key = `merge-face/${Date.now()}.${outType}`;

      const uploadRes = await S3.upload({
        Bucket: AWS_BUCKET,
        Key: key,
        Body: buffer,
        ContentType: `image/${outType}`,
      }).promise();

      return res.json({
        ok: true,
        url: uploadRes.Location,
      });

    } catch (e) {
      console.error("merge-face error:", e?.response?.data || e);
      return res.status(500).json({ ok:false, error:"SERVER_ERROR" });

    } finally {
      await safeUnlink(facePath);
      await safeUnlink(imagePath);
    }
  }
);
