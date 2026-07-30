// Batch card-reading eval / model A/B harness.
//
// Runs each document through the SAME readCard() pipeline the app uses and prints
// what each was read as — the number, whether it passes the Aadhaar checksum, the
// name, the DOB, which reader answered (claude / vision / ocr), and how long it took.
//
// Works today on whatever readers are configured (OpenRouter + OCR). The moment you
// add ANTHROPIC_API_KEY, the same command becomes your Claude test — and to A/B models,
// just change ANTHROPIC_VISION_MODEL between runs and compare.
//
// Usage:
//   node backend/eval-cards.js                    # scans data/uploads/ for PAN/Aadhaar files
//   node backend/eval-cards.js path/to/card.jpg   # one or more explicit files
//
// Load .env the same way the server does, so keys are picked up.
import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { readCard } from "./capture.js";
import { getDocument } from "./documents.js";
import { aadhaarChecksumValid } from "./validators.js";

// Map a file to its document definition. Uploads are named "<lead>__<docId>.<ext>",
// so pull the docId from after "__"; otherwise guess PAN/Aadhaar from the filename.
function docForFile(file) {
  const base = path.basename(file).toLowerCase();
  const m = base.match(/__([a-z0-9_]+)\.[a-z]+$/);
  if (m) {
    const doc = getDocument(m[1]);
    if (doc) return doc;
  }
  if (base.includes("pan")) return getDocument("student_pan");
  if (base.includes("aadhaar") || base.includes("aadhar")) return getDocument("student_aadhaar");
  return null;
}

function isAadhaar(doc) {
  return /aadhaar/i.test(doc?.identifier?.name || "");
}

async function run() {
  const args = process.argv.slice(2);
  let files = args;
  if (files.length === 0) {
    const dir = path.resolve("data/uploads");
    files = fs.existsSync(dir)
      ? fs.readdirSync(dir)
          .filter((f) => /\.(jpg|jpeg|png|pdf)$/i.test(f) && /(pan|aadhaar|aadhar)/i.test(f))
          .map((f) => path.join(dir, f))
      : [];
  }

  if (files.length === 0) {
    console.log("No card files found. Pass file paths, or drop PAN/Aadhaar files in data/uploads/.");
    return;
  }

  // Show which readers are live so the results are easy to interpret.
  const readers = [];
  if (process.env.ANTHROPIC_API_KEY) readers.push(`claude (${process.env.ANTHROPIC_VISION_MODEL || "claude-opus-4-8"})`);
  if (process.env.OPENROUTER_API_KEY) readers.push(`openrouter (${process.env.OPENROUTER_VISION_MODEL || "openai/gpt-4o-mini"})`);
  readers.push("ocr (fallback)");
  console.log(`\nActive readers, in priority order: ${readers.join(" → ")}\n`);

  for (const file of files) {
    const name = path.basename(file);
    let buffer;
    try {
      buffer = fs.readFileSync(file);
    } catch {
      console.log(`✗ ${name} — could not read file`);
      continue;
    }
    const doc = docForFile(file);
    if (!doc) {
      console.log(`? ${name} — couldn't tell if this is a PAN or Aadhaar; skipping`);
      continue;
    }

    const t0 = Date.now();
    const card = await readCard(buffer, doc);
    const ms = Date.now() - t0;

    const checksum = isAadhaar(doc) && card.number ? (aadhaarChecksumValid(card.number) ? " ✓checksum" : " ✗CHECKSUM") : "";
    console.log(`• ${name}`);
    console.log(`    ${doc.identifier?.name || doc.label}: ${card.number || "(not read)"}${checksum}`);
    console.log(`    name: ${card.name || "-"}   dob: ${card.dob || "-"}`);
    console.log(`    read by: ${card.source}   in ${ms} ms\n`);
  }
}

run();
