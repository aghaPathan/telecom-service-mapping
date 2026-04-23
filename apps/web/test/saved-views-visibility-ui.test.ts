import { describe, it, expect } from "vitest";
import { visibilityOptions } from "@/lib/saved-views-visibility-ui";

describe("visibilityOptions", () => {
  it("viewer → only private", () => {
    expect(visibilityOptions("viewer")).toEqual(["private"]);
  });
  it("operator → private + role:viewer + role:operator", () => {
    expect(visibilityOptions("operator")).toEqual([
      "private",
      "role:viewer",
      "role:operator",
    ]);
  });
  it("admin → all four", () => {
    expect(visibilityOptions("admin")).toEqual([
      "private",
      "role:viewer",
      "role:operator",
      "role:admin",
    ]);
  });
});
