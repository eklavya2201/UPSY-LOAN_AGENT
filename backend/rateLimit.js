// Minimal fixed-window-per-key rate limiter, in memory.
//
// Exists because POST /api/voice/session is public — an anonymous visitor on
// /m can call — and every hit mints a billable provider credential. Without a
// cap, one script draining the voice account is a two-line attack.
//
// In memory and per process on purpose: the rest of this demo's state works the
// same way, and it resets on restart, which is acceptable for the traffic this
// sees. A multi-instance deployment would need this in Redis to mean anything.

export function createRateLimiter({ limit, windowMs, maxKeys = 500 }) {
  const hits = new Map(); // key -> number[] of timestamps within the window

  return {
    /**
     * Records an attempt and reports whether it should be rejected.
     * @returns {boolean} true when the caller has exceeded `limit` in `windowMs`.
     */
    check(key, now = Date.now()) {
      const recent = (hits.get(key) || []).filter((t) => now - t < windowMs);
      recent.push(now);
      hits.set(key, recent);

      // Sweep only when the map has actually grown, so the common path stays
      // O(1)-ish rather than walking every key on every request.
      if (hits.size > maxKeys) {
        for (const [k, times] of hits) {
          if (!times.some((t) => now - t < windowMs)) hits.delete(k);
        }
      }
      return recent.length > limit;
    },

    // Test/introspection helper.
    size() {
      return hits.size;
    },
  };
}
