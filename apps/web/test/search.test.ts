import { describe, it, expect } from "vitest";
import {
  escapeLucene,
  parseQuery,
  SearchResponse,
  SearchQuery,
} from "@/lib/search";

describe("parseQuery (zod)", () => {
  it("rejects empty", () => {
    expect(() => parseQuery({ q: "" })).toThrow();
    expect(() => parseQuery({ q: "   " })).toThrow();
  });

  it("trims whitespace", () => {
    expect(parseQuery({ q: "  abc  " }).q).toBe("abc");
  });

  it("caps length at 200", () => {
    expect(() => parseQuery({ q: "x".repeat(201) })).toThrow();
    expect(parseQuery({ q: "x".repeat(200) }).q.length).toBe(200);
  });

  it("rejects missing q", () => {
    expect(() => parseQuery({})).toThrow();
  });
});

describe("escapeLucene", () => {
  // Per Lucene docs, these must be backslash-escaped before being sent to
  // the fulltext index: + - && || ! ( ) { } [ ] ^ " ~ * ? : \ /
  const specials = ['+', '-', '!', '(', ')', '{', '}', '[', ']',
                    '^', '"', '~', '*', '?', ':', '\\', '/'];

  it.each(specials)("escapes %s", (ch) => {
    expect(escapeLucene(ch)).toBe("\\" + ch);
  });

  it("leaves plain ascii alone", () => {
    expect(escapeLucene("device-01")).toBe("device\\-01");
    expect(escapeLucene("ABC_123")).toBe("ABC_123");
  });

  it("escapes && and ||", () => {
    expect(escapeLucene("foo && bar")).toBe("foo \\&\\& bar");
    expect(escapeLucene("foo || bar")).toBe("foo \\|\\| bar");
  });

  it("never produces unterminated backslash", () => {
    // A trailing backslash in user input, when passed to Lucene, would
    // otherwise escape the closing quote / break the query.
    const out = escapeLucene("abc\\");
    expect(out).toBe("abc\\\\");
  });
});

describe("SearchResponse schema", () => {
  it("accepts empty", () => {
    expect(SearchResponse.parse({ kind: "empty" })).toEqual({ kind: "empty" });
  });

  it("accepts device", () => {
    const r = SearchResponse.parse({
      kind: "device",
      devices: [
        { name: "d1", role: "Core", level: 1, site: "s1", domain: "Mpls" },
      ],
    });
    expect(r.kind).toBe("device");
  });

  it("accepts service with endpoints", () => {
    const r = SearchResponse.parse({
      kind: "service",
      service: {
        cid: "C1",
        mobily_cid: "M1",
        bandwidth: "1G",
        protection_type: "1+1",
        region: "North",
      },
      endpoints: [
        { name: "src", role: "UPE", level: 2, site: "s1", domain: "Mpls" },
      ],
    });
    expect(r.kind).toBe("service");
  });

  it("rejects unknown kind", () => {
    expect(() => SearchResponse.parse({ kind: "nope" })).toThrow();
  });
});

describe("SearchQuery schema", () => {
  it("type-exports through parseQuery", () => {
    const q: SearchQuery = parseQuery({ q: "abc" });
    expect(q.q).toBe("abc");
  });
});
