"use client";

import type { Edge, Node } from "reactflow";
import { GraphCanvas } from "@/components/graph/GraphCanvas";

// Six-node mock topology — one core → two UPEs → three CSGs (spanning role
// colors across levels 1/2/3). Pure mock data, no fetch. Lets the preview
// route stand alone without a live Neo4j.
const MOCK_NODES: Node[] = [
  {
    id: "core-01",
    type: "device",
    position: { x: 0, y: 0 },
    data: { name: "JED-CORE-01", role: "CORE", level: 1, site: "JED" },
  },
  {
    id: "upe-01",
    type: "device",
    position: { x: 0, y: 0 },
    data: { name: "JED-UPE-01", role: "UPE", level: 2, site: "JED" },
  },
  {
    id: "upe-02",
    type: "device",
    position: { x: 0, y: 0 },
    data: { name: "JED-UPE-02", role: "UPE", level: 2, site: "JED" },
  },
  {
    id: "csg-01",
    type: "device",
    position: { x: 0, y: 0 },
    data: { name: "JED-CSG-01", role: "CSG", level: 3, site: "JED" },
  },
  {
    id: "csg-02",
    type: "device",
    position: { x: 0, y: 0 },
    data: { name: "JED-CSG-02", role: "CSG", level: 3, site: "JED" },
  },
  {
    id: "csg-cluster",
    type: "cluster",
    position: { x: 0, y: 0 },
    data: { site: "JED", role: "CSG", count: 12 },
  },
];

const MOCK_EDGES: Edge[] = [
  { id: "e1", source: "core-01", target: "upe-01" },
  { id: "e2", source: "core-01", target: "upe-02" },
  { id: "e3", source: "upe-01", target: "csg-01" },
  { id: "e4", source: "upe-01", target: "csg-02" },
  { id: "e5", source: "upe-02", target: "csg-cluster" },
];

export function PreviewCanvas() {
  return <GraphCanvas nodes={MOCK_NODES} edges={MOCK_EDGES} />;
}
