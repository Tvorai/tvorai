import fs from "fs/promises";

export async function safeUnlink(p) {
  if (!p) return;
  try {
    await fs.unlink(p);
  } catch (_) {}
}
