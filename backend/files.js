// Stores uploaded documents on disk so the team can open them later.
// (Prototype: plain files under data/uploads. Production would encrypt at rest
//  and use object storage like S3 — the saveFile/filePath interface stays the same.)

import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const UPLOAD_DIR = path.join(__dirname, "..", "data", "uploads");

export async function saveFile(leadId, docId, file) {
  const ext = (file.originalname.split(".").pop() || "bin").toLowerCase().replace(/[^a-z0-9]/g, "");
  const storedName = `${leadId}__${docId}.${ext}`.replace(/[^a-zA-Z0-9._-]/g, "_");
  await fs.mkdir(UPLOAD_DIR, { recursive: true });
  await fs.writeFile(path.join(UPLOAD_DIR, storedName), file.buffer);
  return { storedName, mimetype: file.mimetype, originalname: file.originalname };
}

// Absolute path for a stored file (name comes from our own record, never user input).
export function filePath(storedName) {
  return path.join(UPLOAD_DIR, storedName);
}
