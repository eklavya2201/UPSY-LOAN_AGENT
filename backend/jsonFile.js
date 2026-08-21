// Durable writes for the JSON stores.
//
// Four modules keep their state in a JSON file — applications, voice accounts,
// reviews, callbacks — and all four had the same three-line save():
//
//     await fs.mkdir(DATA_DIR, { recursive: true });
//     await fs.writeFile(FILE, JSON.stringify(cache, null, 2));
//
// which is wrong in two ways that only show up under load or at shutdown, and
// which this module exists to fix once rather than four times.
//
// ── 1. writeFile is not atomic ──────────────────────────────────────────────
// It truncates the file and then streams the new contents in. A crash, a kill,
// a full disk, or Render/systemd stopping the process partway leaves a
// half-written file — and since it is ONE file holding EVERY record, that is
// not "the last applicant was lost", it is "all of them were". Recovering means
// hand-editing JSON, if there is even a backup to hand-edit from.
//
// Writing to a temp file and renaming it over the original is the standard fix:
// rename(2) is atomic on POSIX, so a reader sees either the whole old file or
// the whole new one, never a torn one. fsync before the rename is the part
// people skip — without it the rename can reach the disk before the data does,
// and a power loss leaves an intact filename pointing at empty content.
//
// ── 2. Nothing serialised concurrent writers ────────────────────────────────
// Two uploads finishing together both ran load() → mutate → save(). Both saw
// the same cache object, so whichever wrote last silently discarded the other's
// change. The window is small and the traffic was low, which is why it never
// bit in testing — it is exactly the bug that starts appearing with real users
// and cannot be reproduced afterwards.
//
// Writes now go through a per-file promise chain, so they happen strictly in
// order and never overlap.

import fs from "fs/promises";
import path from "path";

// Every writer created here, so shutdown can wait for all of them at once.
const writers = new Set();

/**
 * rename(), with the retry Windows requires.
 *
 * ⚠️ THE ATOMIC-RENAME TRICK IS A POSIX GUARANTEE, NOT A UNIVERSAL ONE. On
 * Linux — which is what EC2 runs — rename(2) over an existing file always
 * succeeds, even while another process has that file open for reading, and that
 * is precisely what makes it atomic.
 *
 * Windows does not allow it: if any handle is open on the destination, the
 * rename fails with EPERM. Caught by the durability test, which reads the file
 * in a tight loop while writing it — 29 temp files piled up and not one write
 * landed. Left alone this would have been a bug that only ever appears on the
 * machine the code is written on, which is the worst place for one to hide,
 * because it trains you to distrust the test rather than the code.
 *
 * The open handle is transient, so a short backoff clears it. Ten attempts over
 * ~half a second is far longer than any reader holds the file, and still fails
 * loudly rather than hanging if something is genuinely stuck.
 */
async function renameWithRetry(from, to) {
  const TRANSIENT = new Set(["EPERM", "EBUSY", "EACCES"]);
  for (let attempt = 0; ; attempt++) {
    try {
      await fs.rename(from, to);
      return;
    } catch (e) {
      if (!TRANSIENT.has(e.code) || attempt >= 9) throw e;
      await new Promise((r) => setTimeout(r, 10 * (attempt + 1)));
    }
  }
}

/**
 * A serialised, atomic writer for one JSON file.
 *
 * `serialise` is called at WRITE time, not at queue time, on purpose: by the
 * moment a queued write actually runs, the cache may have moved on, and the
 * newer state is the more correct one to persist.
 */
export function makeJsonWriter(filePath, serialise) {
  let chain = Promise.resolve();
  let queued = false;

  async function writeNow() {
    const dir = path.dirname(filePath);
    await fs.mkdir(dir, { recursive: true });

    // The pid and timestamp keep two processes from colliding on the temp name.
    // They should not be writing the same file at all, but a temp collision
    // would corrupt the thing this module exists to protect.
    const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    const data = serialise();

    let handle;
    try {
      handle = await fs.open(tmp, "w");
      await handle.writeFile(data);
      // Force it to the platter before the rename publishes it. Without this
      // the rename can land first and a power loss leaves a valid filename
      // pointing at nothing.
      await handle.sync();
    } finally {
      if (handle) await handle.close();
    }

    try {
      await renameWithRetry(tmp, filePath);
    } catch (e) {
      // The rename is what publishes the write, so a failure here means nothing
      // was published — the previous file is still intact, which is the correct
      // outcome. Clear the temp file so a repeatedly failing write does not fill
      // the disk with them, then report, because a store that has silently
      // stopped persisting looks exactly like one that is working.
      await fs.unlink(tmp).catch(() => {});
      throw e;
    }
  }

  const writer = {
    /**
     * Queue a write. Returns a promise that settles when the file is on disk.
     *
     * Coalesced: if a write is already waiting to start it will pick up the
     * current state anyway, so queueing a second is pure waste. `queued` is
     * cleared at the START of the write, so a mutation made DURING a write
     * still schedules the next one and cannot be lost.
     */
    save() {
      if (queued) return chain;
      queued = true;
      chain = chain
        .then(async () => {
          queued = false;
          await writeNow();
        })
        .catch((e) => {
          // Never let one failed write poison the chain for every later one.
          // Loud, because a store that has quietly stopped persisting looks
          // exactly like a store that is working.
          console.error(`[store] could not write ${path.basename(filePath)}: ${e.message}`);
        });
      return chain;
    },

    /** Wait for anything in flight. Used by the shutdown handler. */
    flush() {
      return chain;
    },
  };

  writers.add(writer);
  return writer;
}

/**
 * Wait for every store to finish writing.
 *
 * Called from the SIGTERM handler. Two rounds because a write that is mid-flight
 * when the signal arrives can queue one more behind it; the second await catches
 * that successor. Cheap, and the alternative is losing the last change made
 * before a deploy.
 */
export async function flushAllStores() {
  await Promise.allSettled([...writers].map((w) => w.flush()));
  await Promise.allSettled([...writers].map((w) => w.flush()));
}

/**
 * Clear temp files left behind by a process that died mid-write.
 *
 * They are harmless — the rename never happened, so the real file is intact —
 * but they accumulate on a box that crashes repeatedly and are confusing to
 * find later. Best-effort: a failure here must never stop the server booting.
 */
export async function sweepTempFiles(dir) {
  try {
    const names = await fs.readdir(dir);
    const stale = names.filter((n) => /\.\d+\.\d+\.tmp$/.test(n));
    await Promise.allSettled(stale.map((n) => fs.unlink(path.join(dir, n))));
    if (stale.length) console.log(`[store] cleared ${stale.length} temp file(s) from an unclean shutdown`);
  } catch (e) {
    /* no data dir yet, or unreadable — neither is worth failing a boot over */
  }
}
