# ADR 0002 — Graph visualization library

- **Status:** Accepted
- **Date:** 2026-04-23
- **Issue:** [#31](https://github.com/aghaPathan/telecom-service-mapping/issues/31)

## Context

v2 ports v1's topology / impact / core overview views into a Next.js 14 App
Router frontend. The visualization layer must render medium-sized network
graphs (tens to hundreds of devices on a typical page; several hundred when
an operator opens the full core overview), support interactive zoom / pan /
drag, let us attach custom per-node rendering (role icon + level-coded
border + site badge), wire callbacks for navigation, and integrate cleanly
with server-rendered pages that hand the client a pre-fetched payload.

v1 used [`vis-network`](https://visjs.github.io/vis-network/) — a
non-React, jQuery-era canvas library. It works, but every integration
with v2 (event handlers, styling, SSR boundaries) requires bridging React
state through imperative APIs, which is the opposite of the idiomatic
pattern we lean on for the rest of the app.

## Decision

- **Library:** [`reactflow@11`](https://reactflow.dev/).
- **Layout engine:** [`dagre@0.8`](https://github.com/dagrejs/dagre) —
  lightweight, pure-JS layered layout, wrapped by our own
  `components/graph/layout.ts`. Ships a single-function API
  (`layoutGraph(nodes, edges, opts)`); swap to elkjs only if dagre's
  layer-crossing heuristics become a visible problem on real topologies.
- **Integration shape:** a thin `GraphCanvas` wrapper component in
  `components/graph/` exposes a stable `{ nodes, edges, autoLayout?,
  layoutOptions?, showMiniMap? }` prop surface. Consumers provide their
  own `nodes` / `edges` and keep all data concerns (fetching, filtering)
  outside the component. Node and edge type tables are co-located
  (`nodeTypes.tsx`, `edgeTypes.ts`) so new node variants can be added
  without touching callers.
- **Client boundary:** reactflow touches `window` + measures refs on
  render, so every consumer mounts it via `next/dynamic({ ssr: false })`.
  Server pages fetch data, pass it in, and render the canvas client-side
  only. The accompanying keyboard / screen-reader fallback is always
  server-rendered (same pattern the `/map` page uses for Leaflet).

## Rejected alternatives

- **vis-network (v1's choice).** Imperative, non-React; custom node
  rendering means reaching into a canvas-painting API, not writing JSX.
  No App Router story. Keeping it would mean a bridge layer for every
  interaction and would block the design primitives in S19 from reusing
  icon / badge components cleanly.
- **cytoscape.js.** Mature, feature-rich layout options (cola, dagre,
  klay). But cytoscape renders its own canvas — node contents can be
  HTML overlays via extensions, but that path is fragile and adds a
  layout-out-of-sync failure mode. Same integration friction as vis-network
  for our "HTML-first + Tailwind" styling convention. Would win if we
  needed clustering-heavy, 10k+-node graphs, which we don't.
- **visx / @visx/network.** Great for static / print-quality diagrams but
  ships no interaction primitives (pan / drag / select); we'd rebuild
  them on top of d3-zoom. Stronger fit if the target was a dashboard
  diagram, not an interactive operator tool.
- **elkjs for layout.** Better at layer-crossings than dagre, but ~300 KB
  minified (vs. dagre's ~45 KB) and runs in a web worker for acceptable
  performance on larger graphs. Not worth the bundle + infra overhead
  until dagre's quality becomes a visible bottleneck.

## Consequences

- Every page that renders a graph imports `GraphCanvas` via
  `next/dynamic({ ssr: false })`. The ~120 KB reactflow bundle lives in a
  route-scoped chunk; pages that don't render a graph stay unaffected.
- Role icons (S16) flow through `DeviceNode` via `iconFor(role)` — the
  same lookup used elsewhere in the app. No separate icon table for the
  graph.
- Layout is deterministic (dagre seeds ordering by node id / edge
  declaration), so tests can assert positions without floating-point
  noise or time-dependent output.
- S17 (UPE cluster view) adds a `ClusterNode` variant alongside
  `DeviceNode` by extending `NODE_TYPES`; callers don't change.
- S20 (`/topology`) consumes `GraphCanvas` directly. The HITL design
  review we run on this ADR's preview route (`/_graph-preview`) gates
  downstream work — keep the preview in place even after S20 lands so
  future node variants have a fixture surface.

## Non-decisions (explicitly deferred)

- **Real-time updates.** Today every graph is a point-in-time snapshot
  (last ingest). No WebSocket / reactflow hot-patching. Revisit if / when
  streaming ingest lands.
- **Spatial layouts.** Lat/lng-based node positioning would bypass dagre.
  The `/map` page already handles geographic views via Leaflet; reactflow
  remains the topological viewer.
- **Persisted layouts per user.** Autolay on every render for now; save /
  restore can ride on top of reactflow's `useReactFlow().getNodes()` once
  there's a concrete user story.
