// Minimal per-key in-memory token bucket. Single-container deployment so
// a process-local map is the simplest thing that works; a distributed
// bucket would need Redis and isn't justified for MVP.

type Bucket = { tokens: number; updatedAt: number };

const buckets = new Map<string, Bucket>();

export type RateLimitDecision = { ok: boolean; remaining: number };

export function tryConsume(
  key: string,
  opts: { capacity: number; refillPerSec: number; now?: number } = {
    capacity: 20,
    refillPerSec: 2,
  },
): RateLimitDecision {
  const capacity = opts.capacity;
  const refill = opts.refillPerSec;
  const now = opts.now ?? Date.now();
  const b = buckets.get(key) ?? { tokens: capacity, updatedAt: now };
  const elapsedSec = Math.max(0, (now - b.updatedAt) / 1000);
  b.tokens = Math.min(capacity, b.tokens + elapsedSec * refill);
  b.updatedAt = now;
  if (b.tokens < 1) {
    buckets.set(key, b);
    return { ok: false, remaining: Math.floor(b.tokens) };
  }
  b.tokens -= 1;
  buckets.set(key, b);
  return { ok: true, remaining: Math.floor(b.tokens) };
}

// Test-only: reset between test cases so buckets don't leak.
export function __resetBuckets(): void {
  buckets.clear();
}
