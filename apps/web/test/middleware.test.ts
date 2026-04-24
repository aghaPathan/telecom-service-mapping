import { describe, it, expect, vi, afterEach } from "vitest";
import { NextRequest } from "next/server";

// Dynamically import middleware so we can control NODE_ENV via vi.stubEnv
async function loadMiddleware() {
  vi.resetModules();
  const mod = await import("@/middleware");
  return mod.default;
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

function makeRequest(pathname: string) {
  return new NextRequest(new URL(pathname, "http://localhost"));
}

describe("middleware — dev-preview gate (NODE_ENV=production)", () => {
  it("returns 404 for /design-preview in production", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const middleware = await loadMiddleware();
    const res = middleware(makeRequest("/design-preview"));
    expect(res).toBeTruthy();
    expect((res as Response).status).toBe(404);
  });

  it("returns 404 for /graph-preview in production", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const middleware = await loadMiddleware();
    const res = middleware(makeRequest("/graph-preview"));
    expect(res).toBeTruthy();
    expect((res as Response).status).toBe(404);
  });

  it("returns 404 for nested path /design-preview/nested/path in production", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const middleware = await loadMiddleware();
    const res = middleware(makeRequest("/design-preview/nested/path"));
    expect(res).toBeTruthy();
    expect((res as Response).status).toBe(404);
  });

  it("returns 404 for nested /graph-preview/something in production", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const middleware = await loadMiddleware();
    const res = middleware(makeRequest("/graph-preview/something"));
    expect(res).toBeTruthy();
    expect((res as Response).status).toBe(404);
  });
});

describe("middleware — dev-preview gate (NODE_ENV=development)", () => {
  it("does NOT block /design-preview in development (unauthenticated → redirect to /login)", async () => {
    vi.stubEnv("NODE_ENV", "development");
    const middleware = await loadMiddleware();
    const res = middleware(makeRequest("/design-preview"));
    // Should be a redirect to /login, not a 404
    const status = res ? (res as Response).status : 200;
    expect(status).not.toBe(404);
  });

  it("does NOT block /graph-preview in development", async () => {
    vi.stubEnv("NODE_ENV", "development");
    const middleware = await loadMiddleware();
    const res = middleware(makeRequest("/graph-preview"));
    const status = res ? (res as Response).status : 200;
    expect(status).not.toBe(404);
  });
});
