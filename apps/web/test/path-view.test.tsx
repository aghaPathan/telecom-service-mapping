import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { PathView } from "@/app/_components/path-view";
import type { PathResponse } from "@/lib/path";

const ok: PathResponse = {
  status: "ok", length: 3, weighted: false, total_weight: null,
  hops: [
    { name: "Cust", role: "Customer", level: 5, site: "S", domain: "D", in_if: null,    out_if: "Gi0/0", edge_weight_in: null },
    { name: "CSG",  role: "CSG",      level: 3, site: "S", domain: "D", in_if: "Gi0/1", out_if: "Gi0/2", edge_weight_in: null },
    { name: "UPE",  role: "UPE",      level: 2, site: "S", domain: "D", in_if: "Gi0/3", out_if: "Gi0/4", edge_weight_in: null },
    { name: "CORE", role: "CORE",     level: 1, site: "S", domain: "D", in_if: "Gi0/5", out_if: null,    edge_weight_in: null },
  ],
};

describe("PathView", () => {
  it("renders all four hop names in order", () => {
    const html = renderToStaticMarkup(<PathView data={ok} />);
    const cust = html.indexOf("Cust");
    const csg  = html.indexOf("CSG");
    const upe  = html.indexOf("UPE");
    const core = html.indexOf("CORE");
    expect(cust).toBeGreaterThanOrEqual(0);
    expect(csg).toBeGreaterThan(cust);
    expect(upe).toBeGreaterThan(csg);
    expect(core).toBeGreaterThan(upe);
  });

  it("renders interface labels between hops", () => {
    const html = renderToStaticMarkup(<PathView data={ok} />);
    expect(html).toContain("Gi0/0");
    expect(html).toContain("Gi0/5");
  });

  it("zero-hop core-only ok result still renders", () => {
    const single: PathResponse = {
      status: "ok", length: 0, weighted: true, total_weight: 0,
      hops: [{ name: "CORE", role: "CORE", level: 1, site: null, domain: null, in_if: null, out_if: null, edge_weight_in: null }],
    };
    const html = renderToStaticMarkup(<PathView data={single} />);
    expect(html).toContain("CORE");
  });

  it("missing interface data renders em-dash fallbacks in connector and subline", () => {
    const partial: PathResponse = {
      status: "ok", length: 1, weighted: false, total_weight: null,
      hops: [
        { name: "A", role: "Unknown", level: 3, site: null, domain: null, in_if: null, out_if: null, edge_weight_in: null },
        { name: "B", role: "Unknown", level: 2, site: null, domain: null, in_if: null, out_if: null, edge_weight_in: null },
      ],
    };
    const html = renderToStaticMarkup(<PathView data={partial} />);
    expect(html).toContain("A");
    expect(html).toContain("B");
    // Connector is rendered between the two hops.
    expect(html).toContain('data-testid="path-connector"');
    // Isolate the connector region and assert em-dash fallbacks for null
    // in_if / out_if on both sides of the arrow.
    const connectorRegion = html.split('data-testid="path-connector"')[1] ?? "";
    const connectorInner = connectorRegion.split("</div>")[0] ?? "";
    const dashCount = (connectorInner.match(/—/g) ?? []).length;
    expect(dashCount).toBeGreaterThanOrEqual(2);
    // Subline for hops with null site/domain shows em-dash on both sides.
    expect(html).toContain("— · —");
  });

  it("no_path with unreached_at renders reason + hint", () => {
    const html = renderToStaticMarkup(
      <PathView data={{
        status: "no_path", reason: "island",
        unreached_at: { name: "LonelyMW", role: "MW", level: 3.5, site: "SiteX", domain: "Mpls" },
      }} />,
    );
    expect(html.toLowerCase()).toContain("no core reachable");
    expect(html).toContain("LonelyMW");
    expect(html).toContain("MW");
    expect(html).toContain("Mpls");
  });

  it("no_path with null unreached_at renders reason without crash", () => {
    const html = renderToStaticMarkup(
      <PathView data={{ status: "no_path", reason: "service_has_no_endpoint", unreached_at: null }} />,
    );
    expect(html).toMatch(/service.*has.*no.*endpoint/i);
  });

  it("no_path with start_not_found reason", () => {
    const html = renderToStaticMarkup(
      <PathView data={{ status: "no_path", reason: "start_not_found", unreached_at: null }} />,
    );
    expect(html).toMatch(/not.*found/i);
  });

  it("renders per-hop weight badges when weighted", () => {
    const weighted: PathResponse = {
      status: "ok",
      length: 2,
      weighted: true,
      total_weight: 20,
      hops: [
        { name: "A", role: "UPE", level: 2, site: null, domain: null, in_if: null, out_if: "a-b", edge_weight_in: null },
        { name: "B", role: "UPE", level: 2, site: null, domain: null, in_if: "b-a", out_if: "b-c", edge_weight_in: 10 },
        { name: "C", role: "CORE", level: 1, site: null, domain: null, in_if: "c-b", out_if: null, edge_weight_in: 10 },
      ],
    };
    const html = renderToStaticMarkup(<PathView data={weighted} />);
    expect(html).toContain('data-testid="path-weight-badge"');
    expect(html).toContain(">10<"); // inbound weight on B and C
    expect(html).toContain('data-testid="path-total-weight"');
    expect(html).toContain(">20<"); // total
    expect(html).not.toContain('data-testid="path-unweighted-banner"');
  });

  it("renders the 'unweighted' banner and omits weight badges when unweighted", () => {
    const unweighted: PathResponse = {
      status: "ok",
      length: 2,
      weighted: false,
      total_weight: null,
      hops: [
        { name: "A", role: "UPE", level: 2, site: null, domain: null, in_if: null, out_if: "a-b", edge_weight_in: null },
        { name: "B", role: "UPE", level: 2, site: null, domain: null, in_if: "b-a", out_if: "b-c", edge_weight_in: null },
        { name: "C", role: "CORE", level: 1, site: null, domain: null, in_if: "c-b", out_if: null, edge_weight_in: null },
      ],
    };
    const html = renderToStaticMarkup(<PathView data={unweighted} />);
    expect(html).toContain('data-testid="path-unweighted-banner"');
    expect(html).not.toContain('data-testid="path-weight-badge"');
    expect(html).not.toContain('data-testid="path-total-weight"');
  });
});
