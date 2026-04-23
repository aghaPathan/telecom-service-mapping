import { describe, it, expect } from "vitest";
import {
  CreateBody,
  UpdateBody,
  ViewPayload,
  Visibility,
} from "@/lib/saved-views";

const PATH_PAYLOAD = {
  kind: "path" as const,
  query: { kind: "device" as const, value: "PK-KHI-UPE-01" },
};

const DOWNSTREAM_PAYLOAD = {
  kind: "downstream" as const,
  query: { device: "PK-KHI-UPE-01", max_depth: 5, include_transport: false },
};

describe("ViewPayload discriminated union", () => {
  it("accepts a path payload with kind/value query", () => {
    const p = ViewPayload.parse(PATH_PAYLOAD);
    expect(p.kind).toBe("path");
    if (p.kind !== "path") throw new Error("narrowing");
    expect(p.query).toEqual({ kind: "device", value: "PK-KHI-UPE-01" });
  });

  it("accepts a downstream payload and applies DownstreamQuery defaults", () => {
    const p = ViewPayload.parse({
      kind: "downstream",
      query: { device: "PK-KHI-UPE-01" },
    });
    if (p.kind !== "downstream") throw new Error("narrowing");
    expect(p.query.max_depth).toBe(10);
    expect(p.query.include_transport).toBe(false);
  });

  it("rejects unknown kind", () => {
    expect(() =>
      ViewPayload.parse({ kind: "spof", query: { device: "X" } }),
    ).toThrow();
  });

  it("rejects cross-kind payload (path kind with downstream query)", () => {
    expect(() =>
      ViewPayload.parse({
        kind: "path",
        query: { device: "X", max_depth: 5, include_transport: false },
      }),
    ).toThrow();
  });

  it("rejects empty query value", () => {
    expect(() =>
      ViewPayload.parse({ kind: "path", query: { kind: "device", value: "" } }),
    ).toThrow();
  });

  it("rejects extra fields smuggled into a downstream query", () => {
    expect(() =>
      ViewPayload.parse({
        kind: "downstream",
        query: { device: "X", max_depth: 5, include_transport: true, foo: "bar" },
      }),
    ).toThrow();
  });

  it("rejects extra fields smuggled into a path query", () => {
    expect(() =>
      ViewPayload.parse({
        kind: "path",
        query: { kind: "device", value: "X", foo: "bar" },
      }),
    ).toThrow();
  });
});

describe("Visibility enum", () => {
  it("accepts the four allowed literals", () => {
    for (const v of [
      "private",
      "role:viewer",
      "role:operator",
      "role:admin",
    ]) {
      expect(Visibility.parse(v)).toBe(v);
    }
  });

  it("rejects arbitrary role strings", () => {
    expect(() => Visibility.parse("role:superadmin")).toThrow();
    expect(() => Visibility.parse("public")).toThrow();
  });
});

describe("CreateBody", () => {
  it("requires name, trims, rejects empty", () => {
    expect(() =>
      CreateBody.parse({ name: "  ", payload: PATH_PAYLOAD }),
    ).toThrow();
    const ok = CreateBody.parse({
      name: "  My view  ",
      payload: PATH_PAYLOAD,
    });
    expect(ok.name).toBe("My view");
  });

  it("caps name at 120 chars", () => {
    expect(() =>
      CreateBody.parse({ name: "x".repeat(121), payload: PATH_PAYLOAD }),
    ).toThrow();
  });

  it("defaults visibility to 'private'", () => {
    const v = CreateBody.parse({ name: "n", payload: DOWNSTREAM_PAYLOAD });
    expect(v.visibility).toBe("private");
  });
});

describe("UpdateBody", () => {
  it("accepts partial updates", () => {
    expect(UpdateBody.parse({ name: "renamed" })).toEqual({ name: "renamed" });
    expect(UpdateBody.parse({ visibility: "role:viewer" })).toEqual({
      visibility: "role:viewer",
    });
    expect(UpdateBody.parse({ payload: PATH_PAYLOAD }).payload?.kind).toBe(
      "path",
    );
  });

  it("accepts empty object (no-op PATCH)", () => {
    expect(UpdateBody.parse({})).toEqual({});
  });
});
