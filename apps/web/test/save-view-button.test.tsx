import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { SaveViewButton } from "@/app/_components/save-view-button";

const payload = {
  kind: "path" as const,
  query: { kind: "device" as const, value: "E2E-SV-CSG" },
};

describe("SaveViewButton", () => {
  it("renders open toggle with data-testid", () => {
    const html = renderToStaticMarkup(
      <SaveViewButton role="viewer" payload={payload} />,
    );
    expect(html).toMatch(/data-testid="save-view-toggle"/);
  });

  it("viewer sees only 'private' option in the rendered markup", () => {
    const html = renderToStaticMarkup(
      <SaveViewButton role="viewer" payload={payload} defaultOpen />,
    );
    expect(html).toMatch(/value="private"/);
    expect(html).not.toMatch(/value="role:operator"/);
    expect(html).not.toMatch(/value="role:admin"/);
    expect(html).not.toMatch(/value="role:viewer"/);
  });

  it("operator sees private + role:viewer + role:operator but NOT role:admin", () => {
    const html = renderToStaticMarkup(
      <SaveViewButton role="operator" payload={payload} defaultOpen />,
    );
    expect(html).toMatch(/value="private"/);
    expect(html).toMatch(/value="role:viewer"/);
    expect(html).toMatch(/value="role:operator"/);
    expect(html).not.toMatch(/value="role:admin"/);
  });
});
