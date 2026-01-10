import multer from "multer";
import os from "os";
import path from "path";
import crypto from "crypto";

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, os.tmpdir()); // /tmp
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname || "");
    cb(null, crypto.randomBytes(16).toString("hex") + ext);
  },
});

export function makeUploader(maxBytes) {
  return multer({
    storage,
    limits: { fileSize: maxBytes },
  });
}
