// Batch income-extraction eval / model A/B harness — the income-doc counterpart
// to eval-cards.js. Runs each file through the SAME extractIncome() the app uses
// on /api/validate for co_income_proof, and prints what it read: doc type,
// annual/monthly figures (with the ITR ÷12 math shown), holder name, period,
// which reader answered, and latency.
//
// Usage:
//   node backend/eval-income.js                 # scans project root + data/uploads/
//                                                 # for ITR / Form16 / Payslip / Computation files
//   node backend/eval-income.js path/to/doc.pdf  # one or more explicit files
import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { extractIncome } from "./income.js";

const PATTERN = /(itr|form\s*-?16|payslip|salary|computation)/i;

function defaultFiles() {
  const dirs = [path.resolve("."), path.resolve("data/uploads")];
  const found = [];
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir)) {
      if (/\.(pdf|jpg|jpeg|png)$/i.test(f) && PATTERN.test(f)) found.push(path.join(dir, f));
    }
  }
  return found;
}

async function run() {
  const args = process.argv.slice(2);
  const files = args.length ? args : defaultFiles();

  if (files.length === 0) {
    console.log("No income documents found. Pass file paths, or drop ITR/Form16/Payslip/Computation files in the project root or data/uploads/.");
    return;
  }

  const readers = [];
  if (process.env.ANTHROPIC_API_KEY) readers.push(`claude (${process.env.ANTHROPIC_VISION_MODEL || "claude-opus-4-8"})`);
  if (process.env.OPENROUTER_API_KEY) readers.push(`openrouter (${process.env.OPENROUTER_VISION_MODEL || "openai/gpt-4o-mini"})`);
  if (!readers.length) readers.push("(none configured — every file will read as unverified)");
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

    const t0 = Date.now();
    const income = await extractIncome(buffer);
    const ms = Date.now() - t0;

    console.log(`• ${name}`);
    if (!income) {
      console.log(`    (not read — unverified; app would silently keep the lead-source figure)\n`);
      continue;
    }
    console.log(`    docType: ${income.docType}${income.period ? `   period: ${income.period}` : ""}`);
    if (income.docType === "itr" && income.annualIncomeInr) {
      console.log(`    annual: ₹${income.annualIncomeInr.toLocaleString("en-IN")}  ÷12 → monthly: ₹${income.monthlyIncomeInr.toLocaleString("en-IN")}`);
    } else {
      console.log(`    monthly: ₹${income.monthlyIncomeInr.toLocaleString("en-IN")}`);
    }
    console.log(`    name on document: ${income.holderName || "-"}`);
    console.log(`    address on document: ${income.address || "-"}`);
    console.log(`    read by: ${income.source}   in ${ms} ms\n`);
  }
}

run();
