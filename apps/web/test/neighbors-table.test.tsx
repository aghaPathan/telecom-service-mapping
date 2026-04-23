import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { NeighborsTable } from "@/app/_components/neighbors-table";
import type { Neighbor } from "@/lib/device-detail";

const upe1: Neighbor = {
  name: "UPE-1",
  role: "UPE",
  level: 2,
  site: "PK-KHI-AGG-01",
  local_if: "g0/1",
  remote_if: "g0/2",
  status: true,
};

describe("NeighborsTable", () => {
  it("renders headers + a row linking to the neighbor device page", () => {
    const html = renderToStaticMarkup(
      <NeighborsTable
        rows={[upe1]}
        total={1}
        page={0}
        size={50}
        sortBy="role"
        deviceName="SUBJECT"
      />,
    );
    // Headers
    expect(html).toContain("Hostname");
    expect(html).toContain("Role");
    expect(html).toContain("Level");
    expect(html).toContain("Site");
    expect(html).toContain("Interface");
    expect(html).toContain("Status");
    // Neighbor link + fields
    expect(html).toContain('href="/device/UPE-1"');
    expect(html).toContain("UPE-1");
    expect(html).toContain("UPE");
    expect(html).toContain("g0/1");
    expect(html).toContain("g0/2");
    expect(html).toContain("up");
  });

  it("renders empty-state message when rows is empty", () => {
    const html = renderToStaticMarkup(
      <NeighborsTable
        rows={[]}
        total={0}
        page={0}
        size={50}
        sortBy="role"
        deviceName="SUBJECT"
      />,
    );
    expect(html).toContain("No neighbors");
  });

  it("pagination: page 0 with total > size shows next, hides prev", () => {
    const html = renderToStaticMarkup(
      <NeighborsTable
        rows={[upe1]}
        total={60}
        page={0}
        size={50}
        sortBy="role"
        deviceName="SUBJECT"
      />,
    );
    expect(html).toContain('data-testid="neighbors-next"');
    expect(html).not.toContain('data-testid="neighbors-prev"');
    // Next link points to page=1, preserving sort
    expect(html).toMatch(/href="\/device\/SUBJECT\?page=1&amp;sort=role"/);
  });

  it("pagination: last page shows prev, hides next", () => {
    const html = renderToStaticMarkup(
      <NeighborsTable
        rows={[upe1]}
        total={60}
        page={1}
        size={50}
        sortBy="role"
        deviceName="SUBJECT"
      />,
    );
    expect(html).toContain('data-testid="neighbors-prev"');
    expect(html).not.toContain('data-testid="neighbors-next"');
    expect(html).toMatch(/href="\/device\/SUBJECT\?page=0&amp;sort=role"/);
  });

  it("sort toggle: current sort is highlighted, other links to page=0 with new sort", () => {
    const html = renderToStaticMarkup(
      <NeighborsTable
        rows={[upe1]}
        total={1}
        page={3}
        size={50}
        sortBy="role"
        deviceName="SUBJECT"
      />,
    );
    // Current sort marked
    expect(html).toMatch(
      /data-testid="sort-role"[^>]*aria-current="true"/,
    );
    // Other sort link goes to sort=level with page=0 (page reset)
    expect(html).toMatch(
      /data-testid="sort-level"[^>]*href="\/device\/SUBJECT\?page=0&amp;sort=level"/,
    );
  });

  it("status rendering: true → up, false → down, null → —", () => {
    const rows: Neighbor[] = [
      { ...upe1, name: "A", status: true },
      { ...upe1, name: "B", status: false },
      { ...upe1, name: "C", status: null },
    ];
    const html = renderToStaticMarkup(
      <NeighborsTable
        rows={rows}
        total={3}
        page={0}
        size={50}
        sortBy="role"
        deviceName="SUBJECT"
      />,
    );
    expect(html).toContain(">up<");
    expect(html).toContain(">down<");
    expect(html).toContain(">—<");
  });
});
