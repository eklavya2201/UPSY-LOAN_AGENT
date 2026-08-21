// Do the two fixes actually do what they claim?
//
//   1. Concurrent writers must not discard each other's change. The old code
//      had every caller mutate a shared cache and then writeFile the whole
//      thing, so whoever finished last won and the other change vanished.
//   2. A file must never be observed half-written, and a SIGTERM must not land
//      in the middle of one.
import fs from "fs/promises";
import path from "path";
import { spawn } from "child_process";
import { makeJsonWriter, flushAllStores } from "./jsonFile.js";

const TMP = path.join(process.cwd(), "data", "_durability-test.json");
const ok = (m) => console.log("  ok    " + m);
const bad = (m) => { console.log("  FAIL  " + m); failures++; };
let failures = 0;

// ── 1. Concurrent writers ───────────────────────────────────────────────────
console.log("\nconcurrent writers");
{
  let cache = { entries: {} };
  const writer = makeJsonWriter(TMP, () => JSON.stringify(cache, null, 2));

  // 200 callers each add their own key and save, all in the same tick — the
  // shape of two uploads finishing together, multiplied until it would be
  // impossible to miss.
  await Promise.all(
    Array.from({ length: 200 }, (_, i) => {
      cache.entries["k" + i] = i;
      return writer.save();
    })
  );
  await writer.flush();

  const onDisk = JSON.parse(await fs.readFile(TMP, "utf8"));
  const got = Object.keys(onDisk.entries).length;
  if (got === 200) ok(`all 200 concurrent writes survived (${got}/200 keys on disk)`);
  else bad(`${got}/200 keys on disk — writes are still discarding each other`);
}

// ── 2. The file is never observed torn ──────────────────────────────────────
console.log("\nreaders never see a half-written file");
{
  let cache = { blob: "x".repeat(200_000), n: 0 };
  const writer = makeJsonWriter(TMP, () => JSON.stringify(cache, null, 2));

  let torn = 0;
  let reads = 0;
  const reader = setInterval(async () => {
    try {
      const raw = await fs.readFile(TMP, "utf8");
      reads++;
      JSON.parse(raw); // a torn file throws here
    } catch (e) {
      if (e.code !== "ENOENT") torn++;
    }
  }, 1);

  for (let i = 0; i < 60; i++) {
    cache.n = i;
    writer.save();
    await new Promise((r) => setTimeout(r, 8));
  }
  await writer.flush();
  clearInterval(reader);

  if (reads > 10 && torn === 0) ok(`${reads} reads during ${60} writes of a 200KB file, 0 torn`);
  else if (reads <= 10) bad(`only ${reads} reads landed — test did not exercise the race`);
  else bad(`${torn} torn reads — the write is not atomic`);
}

// ── 3. No temp files left behind ────────────────────────────────────────────
{
  const leftovers = (await fs.readdir(path.dirname(TMP))).filter((n) => n.includes("_durability-test") && n.endsWith(".tmp"));
  if (!leftovers.length) ok("no temp files left behind");
  else bad(`${leftovers.length} temp file(s) left behind`);
}

await flushAllStores();
await fs.unlink(TMP).catch(() => {});

// ── 4. SIGTERM drains rather than dropping ──────────────────────────────────
console.log("\nSIGTERM");
{
  const child = spawn(process.execPath, [new URL("server.js", import.meta.url).pathname], {
    env: { ...process.env, PORT: "3994" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  child.stdout.on("data", (d) => (out += d));
  child.stderr.on("data", (d) => (out += d));

  // Wait for it to be listening.
  await new Promise((r) => {
    const t = setInterval(() => { if (out.includes("running on")) { clearInterval(t); r(); } }, 100);
    setTimeout(() => { clearInterval(t); r(); }, 15000);
  });

  const code = await new Promise((resolve) => {
    child.on("exit", (c) => resolve(c));
    child.kill("SIGTERM");
    setTimeout(() => { child.kill("SIGKILL"); resolve("timeout"); }, 15000);
  });

  // ⚠️ Windows has no real SIGTERM. child.kill("SIGTERM") terminates the
  // process rather than delivering a signal, so the handler cannot run and
  // there is nothing here to observe. Linux — which is what EC2 runs — does
  // deliver it, and that is where these three assertions mean something.
  // Reporting a failure on Windows would be the test lying about the code.
  const win = process.platform === "win32";
  const skip = (m) => console.log("  skip  " + m);

  if (code === 0) ok("exited cleanly (code 0)");
  else if (win) skip(`terminated with ${code} — expected on Windows, which has no SIGTERM to deliver`);
  else bad(`exit was ${code}, expected 0`);

  if (/shutting down/i.test(out)) ok("ran the shutdown path rather than dying where it stood");
  else if (win) skip("no shutdown line — Windows cannot deliver the signal to observe it");
  else bad("no shutdown line — the handler did not run");

  if (/all stores flushed/i.test(out)) ok("flushed every store before exiting");
  else if (win) skip("cannot observe the flush without signal delivery");
  else bad("did not report flushing the stores");

  if (!/waiting up to/.test(out)) ok("no live calls, so it did not wait needlessly");
}

console.log("\n" + (failures ? failures + " FAILURE(S)" : "all correct"));
process.exit(failures ? 1 : 0);
