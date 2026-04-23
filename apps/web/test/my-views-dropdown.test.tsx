import { describe, it, expect, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: () => {}, replace: () => {}, refresh: () => {} }),
}));

import { MyViewsDropdown } from "@/app/_components/my-views-dropdown";

describe("MyViewsDropdown", () => {
  it("renders a button with data-testid='my-views-toggle'", () => {
    const html = renderToStaticMarkup(<MyViewsDropdown currentUserId="u-1" />);
    expect(html).toMatch(/data-testid="my-views-toggle"/);
  });

  it("dropdown hidden by default (no my-views-panel in initial markup)", () => {
    const html = renderToStaticMarkup(<MyViewsDropdown currentUserId="u-1" />);
    expect(html).not.toMatch(/data-testid="my-views-panel"/);
  });
});
