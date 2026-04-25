import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { Nav } from "@/app/_components/nav";

const base = { user: { id: "u1", email: "x@y", role: "viewer" as const } };

describe("Nav", () => {
  it("returns null when no session", () => {
    expect(Nav({ session: null })).toBeNull();
  });
  it("renders row 1 for viewer, no admin row", () => {
    const html = renderToStaticMarkup(Nav({ session: base as any }));
    expect(html).toContain('href="/devices"');
    expect(html).toContain('href="/core"');
    expect(html).toContain('href="/map"');
    expect(html).toContain('href="/dwdm"');
    expect(html).toContain('data-testid="nav-row-1"');
    expect(html).not.toContain('data-testid="nav-row-2"');
  });
  it("renders admin row for admin with users/ingestion/audit entries", () => {
    const s = { user: { ...base.user, role: "admin" as const } };
    const html = renderToStaticMarkup(Nav({ session: s as any }));
    expect(html).toContain('data-testid="nav-row-2"');
    expect(html).toContain('href="/admin/users"');
    expect(html).toContain('href="/admin/ingestion"');
    expect(html).toContain('href="/admin/audit"');
  });
  it("does not render admin row for operator", () => {
    const s = { user: { ...base.user, role: "operator" as const } };
    const html = renderToStaticMarkup(Nav({ session: s as any }));
    expect(html).not.toContain('data-testid="nav-row-2"');
    expect(html).not.toContain('href="/admin/ingestion"');
  });
});
