import { describe, it, expect } from "vitest";
import { hashPassword, verifyPassword, BCRYPT_COST } from "@/lib/password";

describe("password", () => {
  it("round-trips", async () => {
    const h = await hashPassword("correct-horse-battery");
    expect(h.startsWith("$2")).toBe(true);
    expect(await verifyPassword("correct-horse-battery", h)).toBe(true);
    expect(await verifyPassword("wrong", h)).toBe(false);
  });
  it("rejects empty / too-short", async () => {
    await expect(hashPassword("")).rejects.toThrow();
    await expect(hashPassword("1234567")).rejects.toThrow(/at least 8/);
  });
  it("BCRYPT_COST is 12", () => {
    expect(BCRYPT_COST).toBe(12);
  });
  it("verifyPassword handles empty inputs safely", async () => {
    expect(await verifyPassword("", "")).toBe(false);
    expect(await verifyPassword("x", "")).toBe(false);
  });
});
