import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { RoleFilteredTable } from "@/components/RoleFilteredTable";
import type { DeviceListRow } from "@/lib/device-list";

const rows: DeviceListRow[] = [
  { name: "PK-KHI-CORE-01", role: "CORE", level: 1, site: "PK-KHI", vendor: "Cisco" },
  { name: "PK-KHI-CORE-02", role: "CORE", level: 1, site: "PK-KHI", vendor: "Cisco" },
  { name: "PK-LHE-UPE-01", role: "UPE", level: 2, site: "PK-LHE", vendor: "Huawei" },
];

const fanoutRows: DeviceListRow[] = [
  { name: "PK-KHI-RAN-01", role: "RAN", level: 4, site: "PK-KHI", vendor: "Nokia", fanout: 17 },
  { name: "PK-KHI-RAN-02", role: "RAN", level: 4, site: "PK-KHI", vendor: "Nokia", fanout: 9 },
];

const baseProps = {
  rows,
  total: rows.length,
  page: 1,
  pageSize: 50,
  sort: "name" as const,
  dir: "asc" as const,
  baseHref: "/summary/CORE",
};

describe("RoleFilteredTable", () => {
  it("renders one row per entry with a link to /device/<encoded>", () => {
    const html = renderToStaticMarkup(<RoleFilteredTable {...baseProps} sort="name" />);
    expect(html).toContain('data-testid="rft-row-PK-KHI-CORE-01"');
    expect(html).toContain('data-testid="rft-row-PK-KHI-CORE-02"');
    expect(html).toContain('data-testid="rft-row-PK-LHE-UPE-01"');
    expect(html).toContain('href="/device/PK-KHI-CORE-01"');
    expect(html).toContain('href="/device/PK-LHE-UPE-01"');
  });

  it("toggles dir on the active sort column and sets asc for inactive columns", () => {
    const html = renderToStaticMarkup(
      <RoleFilteredTable {...baseProps} sort="name" dir="asc" />,
    );
    // Active name header: clicking should toggle to desc
    const nameHeader = extractHeader(html, "name");
    expect(nameHeader).toContain("sort=name");
    expect(nameHeader).toContain("dir=desc");
    // Inactive site header: clicking sets asc
    const siteHeader = extractHeader(html, "site");
    expect(siteHeader).toContain("sort=site");
    expect(siteHeader).toContain("dir=asc");
  });

  it("renders Prev and Next pagination with correct page numbers", () => {
    const html = renderToStaticMarkup(
      <RoleFilteredTable {...baseProps} total={120} page={2} pageSize={50} />,
    );
    expect(html).toContain('data-testid="rft-pagination"');
    const prev = extractTestId(html, "rft-prev");
    const next = extractTestId(html, "rft-next");
    expect(prev).toContain("page=1");
    expect(next).toContain("page=3");
  });

  it("disables/hides Prev on page 1 and Next on the last page", () => {
    const firstPage = renderToStaticMarkup(
      <RoleFilteredTable {...baseProps} total={120} page={1} pageSize={50} />,
    );
    // Prev should not be an active link
    expect(isActiveLink(firstPage, "rft-prev")).toBe(false);
    expect(isActiveLink(firstPage, "rft-next")).toBe(true);

    const lastPage = renderToStaticMarkup(
      <RoleFilteredTable {...baseProps} total={120} page={3} pageSize={50} />,
    );
    expect(isActiveLink(lastPage, "rft-prev")).toBe(true);
    expect(isActiveLink(lastPage, "rft-next")).toBe(false);
  });

  it("renders the Fanout column only when columns include fanout AND a row has fanout", () => {
    // Default columns: no fanout even when rows have it
    const defaultHtml = renderToStaticMarkup(
      <RoleFilteredTable {...baseProps} rows={fanoutRows} total={fanoutRows.length} />,
    );
    expect(defaultHtml).not.toContain('data-testid="rft-header-fanout"');

    // columns includes fanout, rows have fanout: column renders
    const withFanoutHtml = renderToStaticMarkup(
      <RoleFilteredTable
        {...baseProps}
        rows={fanoutRows}
        total={fanoutRows.length}
        columns={["name", "role", "level", "site", "vendor", "fanout"]}
      />,
    );
    expect(withFanoutHtml).toContain('data-testid="rft-header-fanout"');
    expect(withFanoutHtml).toContain(">17<");
    expect(withFanoutHtml).toContain(">9<");

    // columns includes fanout but no row has fanout: column hidden
    const noFanoutValues = renderToStaticMarkup(
      <RoleFilteredTable
        {...baseProps}
        columns={["name", "role", "level", "site", "vendor", "fanout"]}
      />,
    );
    expect(noFanoutValues).not.toContain('data-testid="rft-header-fanout"');
  });

  it("renders CSV link only when csvHref is set", () => {
    const without = renderToStaticMarkup(<RoleFilteredTable {...baseProps} />);
    expect(without).not.toContain('data-testid="rft-csv-link"');

    const withCsv = renderToStaticMarkup(
      <RoleFilteredTable {...baseProps} csvHref="/api/devices/list/csv?mode=byRole&role=CORE" />,
    );
    expect(withCsv).toContain('data-testid="rft-csv-link"');
    expect(withCsv).toContain("/api/devices/list/csv?mode=byRole&role=CORE");
  });

  it("preserves carryParams across sort-link hrefs", () => {
    const html = renderToStaticMarkup(
      <RoleFilteredTable
        {...baseProps}
        sort="name"
        dir="asc"
        carryParams={{ role: "RAN" }}
      />,
    );
    const nameHeader = extractHeader(html, "name");
    expect(nameHeader).toContain("role=RAN");
    const siteHeader = extractHeader(html, "site");
    expect(siteHeader).toContain("role=RAN");
  });
});

// ---------- helpers ----------

function extractTestId(html: string, testid: string): string {
  const re = new RegExp(`<[^>]*data-testid="${testid}"[^>]*>`, "i");
  const m = html.match(re);
  return m ? m[0] : "";
}

function extractHeader(html: string, col: string): string {
  // The <a> inside the header carries the href we want; pull the whole header tag + its anchor.
  const re = new RegExp(
    `<[^>]*data-testid="rft-header-${col}"[^>]*>[\\s\\S]*?</[a-zA-Z]+>`,
    "i",
  );
  const m = html.match(re);
  return m ? m[0] : "";
}

function isActiveLink(html: string, testid: string): boolean {
  const tag = extractTestId(html, testid);
  // An <a href=...> is active; a <span>/<button disabled> / no element is inactive.
  return /^<a\s[^>]*href="/.test(tag);
}
