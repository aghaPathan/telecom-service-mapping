import { describe, it, expect, beforeEach } from "vitest";
import { tryConsume, __resetBuckets } from "@/lib/rate-limit";

describe("tryConsume (token bucket)", () => {
  beforeEach(() => __resetBuckets());

  it("starts full and allows capacity requests", () => {
    let last;
    for (let i = 0; i < 5; i++) {
      last = tryConsume("u1", { capacity: 5, refillPerSec: 1, now: 0 });
      expect(last.ok).toBe(true);
    }
    expect(last!.remaining).toBe(0);
  });

  it("denies when empty", () => {
    const opts = { capacity: 2, refillPerSec: 1, now: 0 };
    tryConsume("u1", opts);
    tryConsume("u1", opts);
    const d = tryConsume("u1", opts);
    expect(d.ok).toBe(false);
  });

  it("refills over time", () => {
    const opts = { capacity: 2, refillPerSec: 1 };
    tryConsume("u1", { ...opts, now: 0 });
    tryConsume("u1", { ...opts, now: 0 });
    expect(tryConsume("u1", { ...opts, now: 0 }).ok).toBe(false);
    // 2 seconds later, bucket refilled by 2
    expect(tryConsume("u1", { ...opts, now: 2000 }).ok).toBe(true);
  });

  it("isolates keys", () => {
    const opts = { capacity: 1, refillPerSec: 0, now: 0 };
    expect(tryConsume("u1", opts).ok).toBe(true);
    expect(tryConsume("u2", opts).ok).toBe(true);
    expect(tryConsume("u1", opts).ok).toBe(false);
  });

  it("never exceeds capacity even after long idle", () => {
    const opts = { capacity: 3, refillPerSec: 10 };
    tryConsume("u1", { ...opts, now: 0 }); // 2 remain
    const d = tryConsume("u1", { ...opts, now: 1_000_000 });
    // After a huge gap, tokens cap at capacity; one consumed → capacity-1
    expect(d.remaining).toBe(2);
  });
});
