import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { PathView } from "@/app/_components/path-view";

// The /path/[name] page is a thin server component that wraps PathView — a
// render test on the child is enough here; full route wiring is covered by
// the e2e spec updates in Task A3.
describe("path-trace page (device)", () => {
  it("renders a 'no path' banner without crashing", () => {
    const html = renderToStaticMarkup(
      <PathView
        data={{ status: "no_path", reason: "island", unreached_at: null }}
      />,
    );
    expect(html).toContain("No core reachable");
  });
});
