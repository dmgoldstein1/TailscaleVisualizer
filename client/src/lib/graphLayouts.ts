import type { Device, Connection } from "@shared/schema";

/**
 * Graph-drawing layout engine.
 *
 * Implements the eight layout families from Graph-Drawing-Algorithms.md
 * (§1 table) plus the adjacency-matrix alternative from §5, all as
 * dependency-free pure functions over the app's Device/Connection model:
 *
 *  1. hierarchical — Sugiyama-style layered layout (BFS layers from the
 *     coordinator + barycenter sweeps for edge-crossing minimization, §2B)
 *  2. force       — Fruchterman–Reingold force-directed placement
 *  3. orthogonal  — layered placement with Manhattan (H/V) edge routing
 *  4. compound    — nested group containers (VLAN/subnet style, §2A)
 *  5. bundled     — circular placement with force-directed edge bundling
 *                    curves routed toward a shared center (§2C)
 *  6. radial      — concentric rings around the coordinator (§1)
 *  7. constraint  — strict alignment: columns = device type, rows ordered
 *                    by status (alignment/grouping/spacing rules, §1)
 *  8. community   — multilevel label-propagation clustering rendered as
 *                    collapsible supernodes (§1)
 *  9. matrix      — adjacency-matrix grid for dense many-to-many views (§5)
 *
 * Cross-cutting primitives (§2) are handled by the renderer, not here:
 *  - edge aggregation  (§2C) via aggregateEdges()
 *  - focus-plus-context (§2D) via neighborsOf()
 *  - semantic zoom     (§2D) via the scale-aware renderer
 *  - stable layout     (§2E) via caller-preserved positions + nodeOffsets
 */

export const VIEW_W = 800;
export const VIEW_H = 600;

export type LayoutMode =
  | "force"
  | "hierarchical"
  | "orthogonal"
  | "radial"
  | "compound"
  | "bundled"
  | "constraint"
  | "community"
  | "matrix";

export interface LayoutMeta {
  id: LayoutMode;
  label: string;
  subtitle: string;
  description: string;
}

export const LAYOUTS: LayoutMeta[] = [
  {
    id: "force",
    label: "Force-directed",
    subtitle: "Peer mesh · attraction + repulsion",
    description:
      "Simulates attraction along edges and repulsion between nodes so connected devices cluster naturally. Best for peer-to-peer networks without a clear hierarchy.",
  },
  {
    id: "hierarchical",
    label: "Hierarchical (Sugiyama)",
    subtitle: "Layers · crossing minimization",
    description:
      "Organizes nodes into layers flowing from the coordinator and reorders each layer (barycenter sweeps) to minimize edge crossings. Best for routers, dependencies and data flow.",
  },
  {
    id: "orthogonal",
    label: "Orthogonal routing",
    subtitle: "Layered + Manhattan edges",
    description:
      "Same layered placement as Hierarchical, but edges use horizontal/vertical segments only — clean infrastructure / circuit-diagram style.",
  },
  {
    id: "radial",
    label: "Radial / concentric",
    subtitle: "Rings around coordinator",
    description:
      "Places the coordinator at the center with BFS rings around it. Best for exploring everything connected to a given machine.",
  },
  {
    id: "compound",
    label: "Compound groups",
    subtitle: "Nested containers by type",
    description:
      "Groups devices into parent containers (server / desktop / mobile / other). Best for VLANs, subnets and large fleets shown as nested regions.",
  },
  {
    id: "bundled",
    label: "Edge bundling",
    subtitle: "Shared routes for dense edges",
    description:
      "Keeps every connection but routes curves through shared control points near the center, like cables in a tray. Best for many overlapping connections.",
  },
  {
    id: "constraint",
    label: "Constraint grid",
    subtitle: "Aligned columns + ordered rows",
    description:
      "Enforces alignment rules: columns are device types, rows are ordered by status. Best for keeping network topology logically organized at a glance.",
  },
  {
    id: "community",
    label: "Community clusters",
    subtitle: "Multilevel · collapsible",
    description:
      "Detects communities with label propagation and collapses each into a supernode. Click a cluster to expand. Best for hundreds of machines shown as a few groups.",
  },
  {
    id: "matrix",
    label: "Adjacency matrix",
    subtitle: "Dense many-to-many grid",
    description:
      "Grid of senders × receivers — filled where a connection exists. Sacrifices topology shape but stays readable when lines would become spaghetti.",
  },
];

export interface XY {
  x: number;
  y: number;
}

export interface GroupBox extends XY {
  id: string;
  label: string;
  w: number;
  h: number;
  memberIds: number[];
}

export interface LayoutResult {
  positions: Map<number, XY>;
  /** Present for compound / community modes. */
  groups?: GroupBox[];
  /** Present for community mode: device id -> community id. */
  communityOf?: Map<number, string>;
}

// ---------------------------------------------------------------------------
// Graph helpers
// ---------------------------------------------------------------------------

export function buildAdjacency(
  devices: Device[],
  connections: Connection[],
): Map<number, Set<number>> {
  const adj = new Map<number, Set<number>>();
  for (const d of devices) adj.set(d.id, new Set());
  for (const c of connections) {
    adj.get(c.fromDeviceId)?.add(c.toDeviceId);
    adj.get(c.toDeviceId)?.add(c.fromDeviceId);
  }
  return adj;
}

export function neighborsOf(
  deviceId: number,
  connections: Connection[],
): Set<number> {
  const out = new Set<number>([deviceId]);
  for (const c of connections) {
    if (c.fromDeviceId === deviceId) out.add(c.toDeviceId);
    if (c.toDeviceId === deviceId) out.add(c.fromDeviceId);
  }
  return out;
}

/** BFS layers outward from root (fallback: highest-degree node). */
export function bfsLayers(
  devices: Device[],
  connections: Connection[],
  rootId?: number,
): number[][] {
  const adj = buildAdjacency(devices, connections);
  const ids = devices.map((d) => d.id);
  if (ids.length === 0) return [];
  let root = rootId;
  if (root === undefined || !adj.has(root)) {
    const coordinator = devices.find((d) => d.isCoordinator);
    if (coordinator) root = coordinator.id;
    else {
      let best = ids[0];
      let bestDeg = -1;
      for (const id of ids) {
        const deg = adj.get(id)?.size ?? 0;
        if (deg > bestDeg) {
          bestDeg = deg;
          best = id;
        }
      }
      root = best;
    }
  }
  const seen = new Set<number>([root]);
  const layers: number[][] = [[root]];
  let frontier = [root];
  while (frontier.length > 0) {
    const next: number[] = [];
    for (const id of frontier) {
      for (const nb of adj.get(id) ?? []) {
        if (!seen.has(nb)) {
          seen.add(nb);
          next.push(nb);
        }
      }
    }
    if (next.length === 0) break;
    layers.push(next);
    frontier = next;
  }
  // Disconnected leftovers each get their own trailing layer.
  const leftover = ids.filter((id) => !seen.has(id));
  for (const id of leftover) layers.push([id]);
  return layers;
}

/** One barycenter sweep: reorder `layer` by mean neighbor position. */
function barycenterOrder(
  layer: number[],
  neighborRank: Map<number, number>,
  adjacency: Map<number, Set<number>>,
): number[] {
  return [...layer]
    .map((id, i) => {
      const nbs = [...(adjacency.get(id) ?? [])].filter((n) =>
        neighborRank.has(n),
      );
      const mean =
        nbs.length > 0
          ? nbs.reduce((s, n) => s + (neighborRank.get(n) ?? 0), 0) / nbs.length
          : i;
      return { id, mean, i };
    })
    .sort((a, b) => a.mean - b.mean || a.i - b.i)
    .map((e) => e.id);
}

// ---------------------------------------------------------------------------
// Layouts
// ---------------------------------------------------------------------------

function centerFallback(
  devices: Device[],
  w = VIEW_W,
  h = VIEW_H,
): Map<number, XY> {
  const m = new Map<number, XY>();
  const cx = w / 2;
  const cy = h / 2;
  const r = Math.min(w, h) * 0.3;
  devices.forEach((d, i) => {
    const a = devices.length > 1 ? (i / devices.length) * 2 * Math.PI : 0;
    m.set(d.id, { x: cx + Math.cos(a) * r, y: cy + Math.sin(a) * r });
  });
  return m;
}

/** 1–2. Layered placement shared by hierarchical + orthogonal. */
export function computeLayeredPositions(
  devices: Device[],
  connections: Connection[],
  w = VIEW_W,
  h = VIEW_H,
): Map<number, XY> {
  if (devices.length === 0) return new Map();
  const adj = buildAdjacency(devices, connections);
  const coordinator = devices.find((d) => d.isCoordinator);
  const layers = bfsLayers(
    devices,
    connections,
    coordinator?.id,
  );
  // Two barycenter sweeps (down then up) to reduce crossings (§2B).
  for (let sweep = 0; sweep < 2; sweep++) {
    for (let l = 1; l < layers.length; l++) {
      const rank = new Map(layers[l - 1].map((id, i) => [id, i] as const));
      layers[l] = barycenterOrder(layers[l], rank, adj);
    }
    for (let l = layers.length - 2; l >= 0; l--) {
      const rank = new Map(layers[l + 1].map((id, i) => [id, i] as const));
      layers[l] = barycenterOrder(layers[l], rank, adj);
    }
  }
  const padX = 70;
  const padTop = 70;
  const padBottom = 70;
  const usableH = h - padTop - padBottom;
  const gapY = layers.length > 1 ? usableH / (layers.length - 1) : 0;
  const pos = new Map<number, XY>();
  layers.forEach((layer, li) => {
    const y = layers.length === 1 ? h / 2 : padTop + li * gapY;
    layer.forEach((id, i) => {
      const x =
        layer.length === 1
          ? w / 2
          : padX + (i / (layer.length - 1)) * (w - padX * 2);
      pos.set(id, { x, y });
    });
  });
  return pos;
}

/** 6. Concentric rings around the coordinator. */
export function computeRadialPositions(
  devices: Device[],
  connections: Connection[],
  w = VIEW_W,
  h = VIEW_H,
): Map<number, XY> {
  if (devices.length === 0) return new Map();
  const coordinator = devices.find((d) => d.isCoordinator);
  const layers = bfsLayers(devices, connections, coordinator?.id);
  const cx = w / 2;
  const cy = h / 2;
  const maxR = Math.min(w, h) / 2 - 60;
  const pos = new Map<number, XY>();
  layers.forEach((layer, li) => {
    if (li === 0) {
      for (const id of layer) pos.set(id, { x: cx, y: cy });
      return;
    }
    const r =
      layers.length <= 2
        ? maxR
        : (li / (layers.length - 1)) * maxR || maxR * 0.5;
    layer.forEach((id, i) => {
      const a = (i / layer.length) * 2 * Math.PI - Math.PI / 2;
      pos.set(id, { x: cx + Math.cos(a) * r, y: cy + Math.sin(a) * r });
    });
  });
  return pos;
}

/** 2. Fruchterman–Reingold force-directed placement (deterministic seed). */
export function computeForcePositions(
  devices: Device[],
  connections: Connection[],
  w = VIEW_W,
  h = VIEW_H,
): Map<number, XY> {
  if (devices.length === 0) return new Map();
  const seed = centerFallback(devices, w, h);
  const pts = devices.map((d) => ({ id: d.id, ...seed.get(d.id)! }));
  const adj = buildAdjacency(devices, connections);
  const n = pts.length;
  const area = w * h;
  const k = Math.sqrt(area / Math.max(n, 1));
  let temp = Math.min(w, h) / 8;
  const cooling = 0.94;
  const edgeSet = new Set(
    connections.map((c) => `${c.fromDeviceId}>${c.toDeviceId}`),
  );
  const hasEdge = (a: number, b: number) =>
    edgeSet.has(`${a}>${b}`) || edgeSet.has(`${b}>${a}`);
  const byId = new Map(pts.map((p) => [p.id, p]));

  for (let iter = 0; iter < 120; iter++) {
    const disp = new Map<number, XY>();
    for (const p of pts) disp.set(p.id, { x: 0, y: 0 });
    // Repulsion (all pairs).
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const a = pts[i];
        const b = pts[j];
        let dx = a.x - b.x;
        let dy = a.y - b.y;
        let dist = Math.hypot(dx, dy) || 0.01;
        const f = (k * k) / dist;
        dx = (dx / dist) * f;
        dy = (dy / dist) * f;
        const da = disp.get(a.id)!;
        const db = disp.get(b.id)!;
        da.x += dx;
        da.y += dy;
        db.x -= dx;
        db.y -= dy;
      }
    }
    // Attraction (edges) + mild gravity to center for isolates.
    for (const p of pts) {
      const d = disp.get(p.id)!;
      for (const nb of adj.get(p.id) ?? []) {
        const q = byId.get(nb);
        if (!q || !hasEdge(p.id, nb)) continue;
        let dx = p.x - q.x;
        let dy = p.y - q.y;
        const dist = Math.hypot(dx, dy) || 0.01;
        const f = (dist * dist) / k;
        dx = (dx / dist) * f;
        dy = (dy / dist) * f;
        d.x -= dx;
        d.y -= dy;
      }
      // Gravity keeps disconnected nodes from drifting off-canvas.
      d.x += (w / 2 - p.x) * 0.02;
      d.y += (h / 2 - p.y) * 0.02;
    }
    for (const p of pts) {
      const d = disp.get(p.id)!;
      const len = Math.hypot(d.x, d.y) || 0.01;
      const capped = Math.min(len, temp);
      p.x += (d.x / len) * capped;
      p.y += (d.y / len) * capped;
      p.x = Math.max(50, Math.min(w - 50, p.x));
      p.y = Math.max(50, Math.min(h - 50, p.y));
    }
    temp *= cooling;
  }
  return new Map(pts.map((p) => [p.id, { x: p.x, y: p.y }]));
}

export function groupKeyFor(device: Device): string {
  const t = device.deviceType;
  if (t === "server" || t === "desktop" || t === "mobile") return t;
  return "other";
}

export function groupLabelFor(key: string): string {
  switch (key) {
    case "server":
      return "Servers";
    case "desktop":
      return "Desktops";
    case "mobile":
      return "Mobile";
    default:
      return "Other";
  }
}

/** 4. Compound: containers per device type, grid packing inside. */
export function computeCompoundLayout(
  devices: Device[],
  _connections: Connection[],
  w = VIEW_W,
  h = VIEW_H,
): LayoutResult {
  const positions = new Map<number, XY>();
  const order = ["server", "desktop", "mobile", "other"];
  const members = new Map<string, Device[]>();
  for (const key of order) members.set(key, []);
  for (const d of devices) members.get(groupKeyFor(d))!.push(d);
  const active = order.filter((k) => members.get(k)!.length > 0);
  if (active.length === 0) return { positions };

  const gap = 16;
  const cols = active.length >= 3 ? 2 : 1;
  const rows = Math.ceil(active.length / cols);
  const boxW = (w - gap * (cols + 1)) / cols;
  const boxH = (h - 60 - gap * (rows + 1)) / rows;
  const groups: GroupBox[] = [];

  active.forEach((key, gi) => {
    const col = gi % cols;
    const row = Math.floor(gi / cols);
    const bx = gap + col * (boxW + gap);
    const by = 48 + gap + row * (boxH + gap);
    const list = members.get(key)!;
    groups.push({
      id: key,
      label: `${groupLabelFor(key)} · ${list.length}`,
      x: bx,
      y: by,
      w: boxW,
      h: boxH,
      memberIds: list.map((d) => d.id),
    });
    // Grid-pack members inside the container.
    const perRow = Math.max(1, Math.ceil(Math.sqrt(list.length)));
    list.forEach((d, i) => {
      const r = Math.floor(i / perRow);
      const c = i % perRow;
      const inRow = Math.min(perRow, list.length - r * perRow);
      const cellW = (boxW - 24) / Math.max(inRow, 1);
      const rowsNeeded = Math.ceil(list.length / perRow);
      const cellH = (boxH - 48) / Math.max(rowsNeeded, 1);
      positions.set(d.id, {
        x: bx + 12 + cellW * (c + 0.5),
        y: by + 34 + cellH * (r + 0.5),
      });
    });
  });
  return { positions, groups };
}

/** 7. Constraint grid: columns = type, rows ordered by status. */
export function computeConstraintPositions(
  devices: Device[],
  _connections: Connection[],
  w = VIEW_W,
  h = VIEW_H,
): Map<number, XY> {
  const pos = new Map<number, XY>();
  const cols = ["server", "desktop", "mobile", "other"];
  const statusRank = (s: string) =>
    s === "connected" ? 0 : s === "unstable" ? 1 : 2;
  const byCol = new Map<string, Device[]>();
  for (const c of cols) byCol.set(c, []);
  for (const d of devices) byCol.get(groupKeyFor(d))!.push(d);
  const activeCols = cols.filter((c) => byCol.get(c)!.length > 0);
  activeCols.forEach((col, ci) => {
    const list = [...byCol.get(col)!].sort(
      (a, b) => statusRank(a.status) - statusRank(b.status),
    );
    const x =
      activeCols.length === 1
        ? w / 2
        : 90 + (ci / (activeCols.length - 1)) * (w - 180);
    list.forEach((d, ri) => {
      const y =
        list.length === 1
          ? h / 2
          : 80 + (ri / (list.length - 1)) * (h - 160);
      pos.set(d.id, { x, y });
    });
  });
  return pos;
}

/** 8. Label-propagation community detection (multilevel, collapsed view). */
export function detectCommunities(
  devices: Device[],
  connections: Connection[],
): Map<number, string> {
  const adj = buildAdjacency(devices, connections);
  const label = new Map<number, number>();
  devices.forEach((d, i) => label.set(d.id, i));
  for (let iter = 0; iter < 8; iter++) {
    let changed = false;
    for (const d of devices) {
      const counts = new Map<number, number>();
      for (const nb of adj.get(d.id) ?? []) {
        const l = label.get(nb)!;
        counts.set(l, (counts.get(l) ?? 0) + 1);
      }
      if (counts.size === 0) continue;
      let best = label.get(d.id)!;
      let bestCount = -1;
      for (const [l, c] of counts) {
        if (c > bestCount || (c === bestCount && l < best)) {
          best = l;
          bestCount = c;
        }
      }
      if (best !== label.get(d.id)) {
        label.set(d.id, best);
        changed = true;
      }
    }
    if (!changed) break;
  }
  // Normalize to dense c0, c1, … ids ordered by size.
  const buckets = new Map<number, number[]>();
  for (const [id, l] of label) {
    if (!buckets.has(l)) buckets.set(l, []);
    buckets.get(l)!.push(id);
  }
  const sorted = [...buckets.values()].sort((a, b) => b.length - a.length);
  const out = new Map<number, string>();
  sorted.forEach((members, i) => {
    for (const id of members) out.set(id, `c${i}`);
  });
  return out;
}

/** 8. Community layout: supernodes in a row, members gridded when expanded. */
export function computeCommunityLayout(
  devices: Device[],
  connections: Connection[],
  expanded: Set<string>,
  w = VIEW_W,
  h = VIEW_H,
): LayoutResult {
  const communityOf = detectCommunities(devices, connections);
  const buckets = new Map<string, Device[]>();
  for (const d of devices) {
    const c = communityOf.get(d.id) ?? "c0";
    if (!buckets.has(c)) buckets.set(c, []);
    buckets.get(c)!.push(d);
  }
  const ids = [...buckets.keys()].sort();
  const positions = new Map<number, XY>();
  const groups: GroupBox[] = [];
  if (ids.length <= 1) {
    // Single community → fall back to force placement, still boxed.
    const fp = computeForcePositions(devices, connections, w, h);
    const only = ids[0] ?? "c0";
    groups.push({
      id: only,
      label: `Cluster 1 · ${devices.length}`,
      x: 24,
      y: 48,
      w: w - 48,
      h: h - 72,
      memberIds: devices.map((d) => d.id),
    });
    return { positions: fp, groups, communityOf };
  }
  // Collapsed supernodes share one row; expanded ones get a taller box.
  const gap = 16;
  const boxW = (w - gap * (ids.length + 1)) / ids.length;
  ids.forEach((cid, i) => {
    const list = buckets.get(cid)!;
    const isOpen = expanded.has(cid);
    const bx = gap + i * (boxW + gap);
    const by = 48 + gap;
    const bh = h - 48 - gap * 2;
    groups.push({
      id: cid,
      label: `Cluster ${i + 1} · ${list.length}`,
      x: bx,
      y: by,
      w: boxW,
      h: bh,
      memberIds: list.map((d) => d.id),
    });
    if (isOpen) {
      const perRow = Math.max(1, Math.ceil(Math.sqrt(list.length)));
      list.forEach((d, k) => {
        const r = Math.floor(k / perRow);
        const c = k % perRow;
        const inRow = Math.min(perRow, list.length - r * perRow);
        const cellW = (boxW - 20) / Math.max(inRow, 1);
        const rowsNeeded = Math.ceil(list.length / perRow);
        const cellH = (bh - 46) / Math.max(rowsNeeded, 1);
        positions.set(d.id, {
          x: bx + 10 + cellW * (c + 0.5),
          y: by + 32 + cellH * (r + 0.5),
        });
      });
    } else {
      // Collapsed: members share the supernode centroid.
      for (const d of list)
        positions.set(d.id, { x: bx + boxW / 2, y: by + bh / 2 });
    }
  });
  return { positions, groups, communityOf };
}

// ---------------------------------------------------------------------------
// Edge helpers
// ---------------------------------------------------------------------------

/** Manhattan (orthogonal) path between two points. */
export function orthogonalPath(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
): string {
  if (Math.abs(x2 - x1) < 4) return `M ${x1} ${y1} L ${x2} ${y2}`;
  if (Math.abs(y2 - y1) < 4) return `M ${x1} ${y1} L ${x2} ${y2}`;
  const mx = (x1 + x2) / 2;
  return `M ${x1} ${y1} L ${mx} ${y1} L ${mx} ${y2} L ${x2} ${y2}`;
}

/** Bundled curve: quadratic control pulled toward canvas center. */
export function bundledPath(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  cx = VIEW_W / 2,
  cy = VIEW_H / 2,
  beta = 0.85,
): string {
  const mx = (x1 + x2) / 2;
  const my = (y1 + y2) / 2;
  const qx = mx * (1 - beta) + cx * beta;
  const qy = my * (1 - beta) + cy * beta;
  return `M ${x1} ${y1} Q ${qx} ${qy} ${x2} ${y2}`;
}

export interface AggregatedEdge {
  key: string;
  fromGroup: string;
  toGroup: string;
  count: number;
  /** Centroid-to-centroid endpoints for rendering. */
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

/**
 * Edge aggregation (§2C): collapse inter-group connections into a single
 * representative edge labeled with the relationship count.
 */
export function aggregateEdges(
  connections: Connection[],
  groupOf: (deviceId: number) => string,
  centroidOf: (group: string) => XY,
): AggregatedEdge[] {
  const counts = new Map<string, { from: string; to: string; n: number }>();
  for (const c of connections) {
    const g1 = groupOf(c.fromDeviceId);
    const g2 = groupOf(c.toDeviceId);
    if (g1 === g2) continue; // intra-group edges stay individual
    const [a, b] = g1 < g2 ? [g1, g2] : [g2, g1];
    const key = `${a}→${b}`;
    const prev = counts.get(key);
    if (prev) prev.n += 1;
    else counts.set(key, { from: a, to: b, n: 1 });
  }
  return [...counts.entries()].map(([key, e]) => {
    const p1 = centroidOf(e.from);
    const p2 = centroidOf(e.to);
    return {
      key,
      fromGroup: e.from,
      toGroup: e.to,
      count: e.n,
      x1: p1.x,
      y1: p1.y,
      x2: p2.x,
      y2: p2.y,
    };
  });
}

/** Dispatch helper used by the renderer. */
export function computeLayout(
  mode: LayoutMode,
  devices: Device[],
  connections: Connection[],
  expandedCommunities: Set<string>,
  w = VIEW_W,
  h = VIEW_H,
): LayoutResult {
  switch (mode) {
    case "hierarchical":
    case "orthogonal":
      return { positions: computeLayeredPositions(devices, connections, w, h) };
    case "radial":
    case "bundled":
      // Bundling uses a circular scaffold; curves do the visual work.
      return { positions: computeRadialPositions(devices, connections, w, h) };
    case "compound":
      return computeCompoundLayout(devices, connections, w, h);
    case "constraint":
      return {
        positions: computeConstraintPositions(devices, connections, w, h),
      };
    case "community":
      return computeCommunityLayout(
        devices,
        connections,
        expandedCommunities,
        w,
        h,
      );
    case "force":
      return { positions: computeForcePositions(devices, connections, w, h) };
    case "matrix":
      return { positions: centerFallback(devices, w, h) };
  }
}

// ---------------------------------------------------------------------------
// Label deconfliction — guarantees legible text in every visualization.
//
// Rule: no label may overlap another label or any node disc. Labels are
// placed greedily in priority order; each tries the slots
// below → above → right → left and takes the first slot whose box clears
// every node disc and every already-placed label. A label with no free
// slot is hidden (the node keeps a <title> tooltip + click modal, so no
// information is lost — hidden beats overlapped). Non-default slots get
// a thin leader line from the node edge to the label anchor.
// ---------------------------------------------------------------------------

export const LABEL_FONT_SIZE = 12;
const LABEL_GAP = 9;
const LABEL_PAD = 3;

export interface LabelSpec {
  key: string;
  /** Node-disc center the label belongs to. */
  x: number;
  y: number;
  /** Node-disc radius. */
  r: number;
  text: string;
  /** Higher wins when labels compete for space. */
  priority: number;
}

export interface PlacedLabel {
  key: string;
  /** Baseline anchor point for the SVG <text>. */
  x: number;
  y: number;
  anchor: "middle" | "start" | "end";
  visible: boolean;
  /** True when the label is not in its default below-node slot. */
  leader: boolean;
  /** Point on the node-disc edge where a leader line starts. */
  edgeX: number;
  edgeY: number;
  /** Estimated label box (viewBox units), for sub-label stacking. */
  boxX: number;
  boxY: number;
  boxW: number;
  boxH: number;
}

export interface ObstacleDisc {
  x: number;
  y: number;
  r: number;
}

export interface ObstacleRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Conservative width estimate for a single-line SVG label. */
export function estimateTextWidth(text: string, fontSize = LABEL_FONT_SIZE): number {
  return text.length * fontSize * 0.6;
}

export function labelBoxHeight(fontSize = LABEL_FONT_SIZE): number {
  return fontSize * 1.35;
}

function rectsOverlap(
  a: ObstacleRect,
  b: ObstacleRect,
  pad = 0,
): boolean {
  return (
    a.x - pad < b.x + b.w + pad &&
    a.x + a.w + pad > b.x - pad &&
    a.y - pad < b.y + b.h + pad &&
    a.y + a.h + pad > b.y - pad
  );
}

function rectHitsDisc(
  rect: ObstacleRect,
  disc: ObstacleDisc,
  pad = 0,
): boolean {
  const cx = Math.max(rect.x, Math.min(disc.x, rect.x + rect.w));
  const cy = Math.max(rect.y, Math.min(disc.y, rect.y + rect.h));
  const dx = disc.x - cx;
  const dy = disc.y - cy;
  return dx * dx + dy * dy < (disc.r + pad) * (disc.r + pad);
}

/** True when a box clears every fixed rect and node disc. */
export function boxIsFree(
  box: ObstacleRect,
  rects: ObstacleRect[],
  discs: ObstacleDisc[],
  pad = 3,
): boolean {
  if (rects.some((t) => rectsOverlap(box, t, pad))) return false;
  if (discs.some((d) => rectHitsDisc(box, d, pad))) return false;
  return true;
}

export function placeLabels(
  specs: LabelSpec[],
  discs: ObstacleDisc[],
  fixedRects: ObstacleRect[] = [],
  fontSize = LABEL_FONT_SIZE,
): Map<string, PlacedLabel> {
  const out = new Map<string, PlacedLabel>();
  const taken: ObstacleRect[] = [...fixedRects];
  const ordered = [...specs].sort((a, b) => b.priority - a.priority);
  const h = labelBoxHeight(fontSize);

  for (const spec of ordered) {
    const w = estimateTextWidth(spec.text, fontSize);
    const r = spec.r;
    // Candidate slots: [anchor, baselineX(), baselineY(), boxX(), boxY()].
    const slots: Array<{
      anchor: "middle" | "start" | "end";
      leader: boolean;
      tx: number;
      ty: number;
      bx: number;
      by: number;
    }> = [
      {
        anchor: "middle",
        leader: false,
        tx: spec.x,
        ty: spec.y + r + LABEL_GAP + h * 0.82,
        bx: spec.x - w / 2,
        by: spec.y + r + LABEL_GAP,
      },
      {
        anchor: "middle",
        leader: true,
        tx: spec.x,
        ty: spec.y - r - LABEL_GAP,
        bx: spec.x - w / 2,
        by: spec.y - r - LABEL_GAP - h,
      },
      {
        anchor: "start",
        leader: true,
        tx: spec.x + r + LABEL_GAP,
        ty: spec.y + fontSize * 0.35,
        bx: spec.x + r + LABEL_GAP,
        by: spec.y - h / 2,
      },
      {
        anchor: "end",
        leader: true,
        tx: spec.x - r - LABEL_GAP,
        ty: spec.y + fontSize * 0.35,
        bx: spec.x - r - LABEL_GAP - w,
        by: spec.y - h / 2,
      },
    ];

    let placed: PlacedLabel | null = null;
    for (const s of slots) {
      const box: ObstacleRect = { x: s.bx, y: s.by, w, h };
      if (taken.some((t) => rectsOverlap(box, t, LABEL_PAD))) continue;
      if (discs.some((d) => rectHitsDisc(box, d, LABEL_PAD))) continue;
      // Leader line must start on this label's own disc edge.
      const dx = s.tx - spec.x;
      const dy = s.ty - spec.y;
      const len = Math.hypot(dx, dy) || 1;
      placed = {
        key: spec.key,
        x: s.tx,
        y: s.ty,
        anchor: s.anchor,
        visible: true,
        leader: s.leader,
        edgeX: spec.x + (dx / len) * r,
        edgeY: spec.y + (dy / len) * r,
        boxX: box.x,
        boxY: box.y,
        boxW: box.w,
        boxH: box.h,
      };
      taken.push(box);
      break;
    }
    out.set(
      spec.key,
      placed ?? {
        key: spec.key,
        x: spec.x,
        y: spec.y + r + LABEL_GAP,
        anchor: "middle",
        visible: false,
        leader: false,
        edgeX: spec.x,
        edgeY: spec.y,
        boxX: 0,
        boxY: 0,
        boxW: 0,
        boxH: 0,
      },
    );
  }
  return out;
}

/**
 * Nudge an edge-count badge pill away from node discs: try offsets along
 * the edge perpendicular, nearest first; return the first center whose
 * pill clears every disc.
 */
export function nudgeBadgeCenter(
  cx: number,
  cy: number,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  pillW: number,
  pillH: number,
  discs: ObstacleDisc[],
): { x: number; y: number } {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len = Math.hypot(dx, dy) || 1;
  const px = -dy / len;
  const py = dx / len;
  for (const off of [0, 16, -16, 32, -32, 48, -48]) {
    const x = cx + px * off;
    const y = cy + py * off;
    const rect: ObstacleRect = { x: x - pillW / 2, y: y - pillH / 2, w: pillW, h: pillH };
    if (!discs.some((d) => rectHitsDisc(rect, d, 4))) return { x, y };
  }
  return { x: cx, y: cy };
}
