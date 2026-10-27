import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ZoomIn, ZoomOut, Maximize2, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { AdjacencyMatrix } from "@/components/AdjacencyMatrix";
import {
  VIEW_W,
  VIEW_H,
  LAYOUTS,
  LABEL_FONT_SIZE,
  boxIsFree,
  computeLayout,
  neighborsOf,
  orthogonalPath,
  bundledPath,
  aggregateEdges,
  groupKeyFor,
  placeLabels,
  estimateTextWidth,
  labelBoxHeight,
  nudgeBadgeCenter,
  type LayoutMode,
  type ObstacleDisc,
  type ObstacleRect,
} from "@/lib/graphLayouts";
import type { Device, Connection } from "@shared/schema";

interface NetworkTopologyProps {
  devices: Device[];
  connections: Connection[];
  onDeviceClick: (device: Device) => void;
}

interface PositionedDevice extends Device {
  layoutX: number;
  layoutY: number;
}

const MIN_SCALE = 0.5;
const MAX_SCALE = 2.5;
const CLICK_DRAG_THRESHOLD_PX = 5;

// A persisted position is only reused when it actually falls inside the
// viewBox — legacy rows store pixel-space coordinates that would otherwise
// render nodes off-canvas (invisible and unclickable).
// (Plain boolean, not a type guard: Device.x/y are typed non-null, so the
// false branch would otherwise narrow to `never`.)
function hasUsablePosition(d: Device): boolean {
  return (
    typeof d.x === "number" &&
    typeof d.y === "number" &&
    d.x >= 0 &&
    d.x <= VIEW_W &&
    d.y >= 0 &&
    d.y <= VIEW_H
  );
}

function nodeRadius(d: Device): number {
  if (d.isCoordinator) return 30;
  if (d.deviceType === "server") return 25;
  if (d.deviceType === "mobile") return 20;
  return 22;
}

/** Initial visualization method; `?layout=<id>` deep-links a specific view. */
function initialLayoutMode(): LayoutMode {
  const q = new URLSearchParams(window.location.search).get("layout");
  if (q && (LAYOUTS.some((l) => l.id === q) as boolean)) return q as LayoutMode;
  return "force";
}

export function NetworkTopology({
  devices,
  connections,
  onDeviceClick,
}: NetworkTopologyProps) {
  const svgRef = useRef<SVGSVGElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // View transform in viewBox units: screen(x) = pan + scale * x
  const [scale, setScale] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  // Per-node drag offsets in viewBox units (local only, never mutates props)
  const [nodeOffsets, setNodeOffsets] = useState<Map<number, { x: number; y: number }>>(new Map());

  // --- Visualization-method state (Graph-Drawing-Algorithms.md §1 + §5) ---
  const [layoutMode, setLayoutMode] = useState<LayoutMode>(initialLayoutMode);
  // Edge aggregation (§2C): collapse inter-group links into one thick edge.
  const [aggregate, setAggregate] = useState(false);
  // Focus-plus-context (§2D): hovering a node dims non-neighbors.
  const [focusOn, setFocusOn] = useState(true);
  const [focusId, setFocusId] = useState<number | null>(null);
  // Community supernodes: which clusters are expanded.
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  // Active gesture bookkeeping (refs so handlers stay fresh without re-binding)
  const gestureRef = useRef<
    | {
        kind: "pan" | "node";
        nodeId?: string;
        startClientX: number;
        startClientY: number;
        lastSvgX: number;
        lastSvgY: number;
        origOffsetX: number;
        origOffsetY: number;
        moved: boolean;
      }
    | null
  >(null);
  // Set when a pointer gesture turned into a drag — next click is swallowed
  const suppressClickRef = useRef(false);
  const stateRef = useRef({ scale, pan });
  stateRef.current = { scale, pan };

  // Device type emojis
  const getDeviceEmoji = (deviceType: string, isCoordinator: boolean) => {
    if (isCoordinator) return "🔗";
    switch (deviceType) {
      case "desktop":
        return "💻";
      case "mobile":
        return "📱";
      case "server":
        return "🖥️";
      default:
        return "📟";
    }
  };

  // Status colors
  const getStatusColor = (status: string) => {
    switch (status) {
      case "connected":
        return "var(--connected-green)";
      case "unstable":
        return "var(--warning-yellow)";
      case "disconnected":
        return "hsl(240, 5%, 65%)";
      default:
        return "hsl(240, 5%, 65%)";
    }
  };

  // --- Layout computation -----------------------------------------------
  const expandedSet = useMemo(() => expanded, [expanded]);
  const layoutResult = useMemo(
    () => computeLayout(layoutMode, devices, connections, expandedSet),
    [layoutMode, devices, connections, expandedSet],
  );

  // Stable incremental layout (§2E): manual drag offsets survive data
  // refreshes and mode switches. Stored DB coordinates are honored in
  // force mode (the free-form canvas); every other mode recomputes so
  // switching methods visibly changes the picture.
  const positionedDevices: PositionedDevice[] = useMemo(() => {
    return devices.map((d) => {
      let base = layoutResult.positions.get(d.id);
      if (!base) base = { x: VIEW_W / 2, y: VIEW_H / 2 };
      if (layoutMode === "force" && hasUsablePosition(d)) {
        base = { x: d.x, y: d.y };
      }
      const offset = nodeOffsets.get(d.id);
      return {
        ...d,
        layoutX: base.x + (offset?.x ?? 0),
        layoutY: base.y + (offset?.y ?? 0),
      };
    });
  }, [devices, layoutResult, nodeOffsets, layoutMode]);

  const deviceById = useMemo(
    () => new Map(positionedDevices.map((d) => [d.id, d])),
    [positionedDevices],
  );

  const groups = layoutResult.groups;
  const communityOf = layoutResult.communityOf;

  const collapsedGroupIds = useMemo(() => {
    if (layoutMode !== "community" || !groups) return new Set<string>();
    return new Set(groups.filter((g) => !expanded.has(g.id)).map((g) => g.id));
  }, [layoutMode, groups, expanded]);

  const isHiddenByCollapse = useCallback(
    (deviceId: number) => {
      if (collapsedGroupIds.size === 0 || !communityOf) return false;
      const c = communityOf.get(deviceId);
      return c !== undefined && collapsedGroupIds.has(c);
    },
    [collapsedGroupIds, communityOf],
  );

  const visibleDevices = useMemo(
    () => positionedDevices.filter((d) => !isHiddenByCollapse(d.id)),
    [positionedDevices, isHiddenByCollapse],
  );

  // groupOf() powers edge aggregation in every graph mode: explicit
  // containers when they exist, device-type grouping otherwise.
  const groupOf = useCallback(
    (deviceId: number): string => {
      if (groups) {
        const g = groups.find((gr) => gr.memberIds.includes(deviceId));
        if (g) return `group:${g.id}`;
      }
      if (communityOf?.has(deviceId)) return `comm:${communityOf.get(deviceId)}`;
      const d = deviceById.get(deviceId);
      return `type:${d ? groupKeyFor(d) : "other"}`;
    },
    [groups, communityOf, deviceById],
  );

  const centroidOf = useCallback(
    (group: string): { x: number; y: number } => {
      if (groups) {
        const g = groups.find(
          (gr) => `group:${gr.id}` === group || `comm:${gr.id}` === group,
        );
        if (g) return { x: g.x + g.w / 2, y: g.y + g.h / 2 };
      }
      let sx = 0;
      let sy = 0;
      let n = 0;
      for (const d of positionedDevices) {
        if (groupOf(d.id) === group) {
          sx += d.layoutX;
          sy += d.layoutY;
          n += 1;
        }
      }
      if (n > 0) return { x: sx / n, y: sy / n };
      return { x: VIEW_W / 2, y: VIEW_H / 2 };
    },
    [groups, positionedDevices, groupOf],
  );

  // Auto-aggregate when collapsed supernodes exist (members share one
  // centroid, so individual lines would stack invisibly).
  const aggregationActive =
    layoutMode !== "matrix" &&
    (aggregate || collapsedGroupIds.size > 0) &&
    connections.length > 0;

  const aggregated = useMemo(() => {
    if (!aggregationActive) return [];
    return aggregateEdges(connections, groupOf, centroidOf);
  }, [aggregationActive, connections, groupOf, centroidOf]);

  // Individual edges to draw: hide inter-group links when they are
  // represented by an aggregate edge, and hide links touching collapsed
  // members (their supernode edge stands in).
  const individualEdges = useMemo(() => {
    return connections.filter((c) => {
      const from = deviceById.get(c.fromDeviceId);
      const to = deviceById.get(c.toDeviceId);
      if (!from || !to) return false;
      if (isHiddenByCollapse(c.fromDeviceId) || isHiddenByCollapse(c.toDeviceId))
        return false;
      if (aggregationActive && groupOf(c.fromDeviceId) !== groupOf(c.toDeviceId))
        return false;
      return true;
    });
  }, [connections, deviceById, isHiddenByCollapse, aggregationActive, groupOf]);

  const focusSet = useMemo(() => {
    if (!focusOn || focusId === null) return null;
    return neighborsOf(focusId, connections);
  }, [focusOn, focusId, connections]);

  const activeLayout = LAYOUTS.find((l) => l.id === layoutMode)!;

  // Semantic zoom (§2D): detail level follows the zoom factor.
  const showLabels = scale > 0.6;
  const showDetails = scale >= 1.35;

  // --- Label deconfliction: no text on text, no text on nodes. ---------
  // Node discs + supernode discs are obstacles; group pills and edge-count
  // badges are fixed rects that labels must also avoid. Anything without a
  // free slot is hidden (the node keeps a <title> tooltip + click modal).
  const degreeOf = useMemo(() => {
    const m = new Map<number, number>();
    for (const c of connections) {
      m.set(c.fromDeviceId, (m.get(c.fromDeviceId) ?? 0) + 1);
      m.set(c.toDeviceId, (m.get(c.toDeviceId) ?? 0) + 1);
    }
    return m;
  }, [connections]);

  const collapsedSupernodes = useMemo(() => {
    if (layoutMode !== "community" || !groups) return [];
    return groups.filter((g) => collapsedGroupIds.has(g.id));
  }, [layoutMode, groups, collapsedGroupIds]);

  const discs: ObstacleDisc[] = useMemo(
    () => [
      ...visibleDevices.map((d) => ({
        x: d.layoutX,
        y: d.layoutY,
        r: nodeRadius(d),
      })),
      ...collapsedSupernodes.map((g) => ({
        x: g.x + g.w / 2,
        y: g.y + g.h / 2,
        r: 34,
      })),
    ],
    [visibleDevices, collapsedSupernodes],
  );

  const groupPillOf = useMemo(() => {
    const m = new Map<string, ObstacleRect>();
    if (groups) {
      for (const g of groups) {
        const w = estimateTextWidth(g.label) + 14;
        m.set(g.id, { x: g.x + 12 - 7, y: g.y + 20 - 15, w, h: 21 });
      }
    }
    return m;
  }, [groups]);

  const badgeLayout = useMemo(() => {
    if (!aggregationActive) return [];
    return aggregated.map((a) => {
      const text = `${a.count} link${a.count === 1 ? "" : "s"}`;
      const pillW = estimateTextWidth(text, 11) + 22;
      const pillH = labelBoxHeight(11) + 10;
      const c = nudgeBadgeCenter(
        (a.x1 + a.x2) / 2,
        (a.y1 + a.y2) / 2,
        a.x1,
        a.y1,
        a.x2,
        a.y2,
        pillW,
        pillH,
        discs,
      );
      return {
        ...a,
        text,
        pillW,
        pillH,
        cx: c.x,
        cy: c.y,
        rect: {
          x: c.x - pillW / 2,
          y: c.y - pillH / 2,
          w: pillW,
          h: pillH,
        } as ObstacleRect,
      };
    });
  }, [aggregationActive, aggregated, discs]);

  const placements = useMemo(() => {
    if (layoutMode === "matrix") return new Map();
    const specs = [
      ...visibleDevices.map((d) => ({
        key: `node:${d.id}`,
        x: d.layoutX,
        y: d.layoutY,
        r: nodeRadius(d),
        text: d.name,
        priority: (d.isCoordinator ? 1000 : 10) + (degreeOf.get(d.id) ?? 0),
      })),
      ...collapsedSupernodes.map((g) => ({
        key: `super:${g.id}`,
        x: g.x + g.w / 2,
        y: g.y + g.h / 2,
        r: 34,
        text: g.label,
        priority: 5,
      })),
    ];
    return placeLabels(
      specs,
      discs,
      [...groupPillOf.values(), ...badgeLayout.map((b) => b.rect)],
      LABEL_FONT_SIZE,
    );
  }, [
    layoutMode,
    visibleDevices,
    collapsedSupernodes,
    discs,
    groupPillOf,
    badgeLayout,
    degreeOf,
  ]);

  // IP sub-labels stack under default below-node labels when there is room.
  const subLabels = useMemo(() => {
    const out = new Map<number, { x: number; y: number }>();
    if (!showLabels || !showDetails || layoutMode === "matrix") return out;
    const occupied: ObstacleRect[] = [
      ...groupPillOf.values(),
      ...badgeLayout.map((b) => b.rect),
    ];
    for (const p of placements.values()) {
      if (p.visible)
        occupied.push({ x: p.boxX, y: p.boxY, w: p.boxW, h: p.boxH });
    }
    for (const d of visibleDevices) {
      const p = placements.get(`node:${d.id}`);
      if (!p?.visible || p.leader) continue;
      const w = estimateTextWidth(d.ipAddress, 10);
      const h = labelBoxHeight(10);
      const box: ObstacleRect = {
        x: p.x - w / 2,
        y: p.boxY + p.boxH + 2,
        w,
        h,
      };
      if (!boxIsFree(box, occupied, discs)) continue;
      occupied.push(box);
      out.set(d.id, { x: p.x, y: box.y + h * 0.82 });
    }
    return out;
  }, [
    showLabels,
    showDetails,
    layoutMode,
    groupPillOf,
    badgeLayout,
    placements,
    visibleDevices,
    discs,
  ]);

  const toggleCommunity = useCallback((groupId: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(groupId)) next.delete(groupId);
      else next.add(groupId);
      return next;
    });
  }, []);

  const expandAll = useCallback(() => {
    if (groups) setExpanded(new Set(groups.map((g) => g.id)));
  }, [groups]);

  const collapseAll = useCallback(() => {
    setExpanded(new Set());
  }, []);

  // Window-level move/up listeners: reliable for drags that leave the SVG,
  // with no setPointerCapture (which would retarget click away from nodes).
  // Stable identities (refs + setState only) so removeEventListener works.
  const toSvgPoint = useCallback((clientX: number, clientY: number) => {
    const svg = svgRef.current;
    if (!svg) return { x: 0, y: 0 };
    const ctm = svg.getScreenCTM();
    if (!ctm) return { x: 0, y: 0 };
    const pt = new DOMPoint(clientX, clientY).matrixTransform(ctm.inverse());
    return { x: pt.x, y: pt.y };
  }, []);

  const handleWinMove = useCallback(
    (e: PointerEvent) => {
      const g = gestureRef.current;
      if (!g) return;
      if (
        Math.hypot(e.clientX - g.startClientX, e.clientY - g.startClientY) >
        CLICK_DRAG_THRESHOLD_PX
      ) {
        g.moved = true;
        suppressClickRef.current = true;
      }
      if (!g.moved) return;
      const p = toSvgPoint(e.clientX, e.clientY);
      const dx = p.x - g.lastSvgX;
      const dy = p.y - g.lastSvgY;
      g.lastSvgX = p.x;
      g.lastSvgY = p.y;
      if (g.kind === "pan") {
        setPan((prev) => ({ x: prev.x + dx, y: prev.y + dy }));
      } else if (g.nodeId !== undefined) {
        // Node positions are scaled by `scale` on screen: divide the
        // viewBox delta so the node tracks the cursor 1:1 at any zoom.
        const ds = stateRef.current.scale || 1;
        const stepX = dx / ds;
        const stepY = dy / ds;
        // A supernode drag moves every collapsed member with it.
        const targets: number[] = g.nodeId.startsWith("group:")
          ? (groups?.find((gr) => `group:${gr.id}` === g.nodeId)?.memberIds ?? [])
          : [Number(g.nodeId)];
        g.origOffsetX += stepX;
        g.origOffsetY += stepY;
        const ox = g.origOffsetX;
        const oy = g.origOffsetY;
        setNodeOffsets((prev) => {
          const next = new Map(prev);
          for (const id of targets) {
            const cur = prev.get(id) ?? { x: 0, y: 0 };
            if (targets.length === 1) {
              next.set(id, { x: ox, y: oy });
            } else {
              next.set(id, { x: cur.x + stepX, y: cur.y + stepY });
            }
          }
          return next;
        });
      }
    },
    [toSvgPoint, groups],
  );

  const handleWinUp = useCallback(() => {
    gestureRef.current = null;
    window.removeEventListener("pointermove", handleWinMove);
    window.removeEventListener("pointerup", handleWinUp);
    window.removeEventListener("pointercancel", handleWinUp);
  }, [handleWinMove]);

  // Window-level move/up listeners: reliable for drags that leave the SVG,
  // with no setPointerCapture (which would retarget click away from nodes).
  // Stable identities (refs + setState only) so removeEventListener works.
  // (useCallback definitions live above; see handleWinMove/handleWinUp.)

  const beginGesture = (e: React.PointerEvent) => {
    window.addEventListener("pointermove", handleWinMove);
    window.addEventListener("pointerup", handleWinUp);
    window.addEventListener("pointercancel", handleWinUp);
    e.preventDefault();
  };

  const zoomAt = (clientX: number, clientY: number, factor: number) => {
    const { scale: s, pan: p } = stateRef.current;
    const next = Math.min(MAX_SCALE, Math.max(MIN_SCALE, Number((s * factor).toFixed(3))));
    if (next === s) return;
    // Keep the content point under the cursor stationary: t' = p0 - (s'/s)(p0 - t)
    const k = next / s;
    const origin = toSvgPoint(clientX, clientY);
    setScale(next);
    setPan({ x: origin.x - k * (origin.x - p.x), y: origin.y - k * (origin.y - p.y) });
  };

  const handleZoomIn = () => {
    const el = containerRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    zoomAt(r.x + r.width / 2, r.y + r.height / 2, 1.2);
  };

  const handleZoomOut = () => {
    const el = containerRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    zoomAt(r.x + r.width / 2, r.y + r.height / 2, 1 / 1.2);
  };

  const handleResetView = () => {
    setScale(1);
    setPan({ x: 0, y: 0 });
  };

  const handleResetLayout = () => {
    setNodeOffsets(new Map());
  };

  // Wheel zoom (native listener: React's onWheel is passive, we need preventDefault)
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg || layoutMode === "matrix") return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      zoomAt(e.clientX, e.clientY, e.deltaY < 0 ? 1.15 : 1 / 1.15);
    };
    svg.addEventListener("wheel", onWheel, { passive: false });
    return () => svg.removeEventListener("wheel", onWheel);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layoutMode]);

  const handleDeviceClick = (device: Device) => {
    if (suppressClickRef.current) {
      suppressClickRef.current = false;
      return;
    }
    onDeviceClick(device);
  };

  const onBackgroundPointerDown = (e: React.PointerEvent) => {
    const p = toSvgPoint(e.clientX, e.clientY);
    gestureRef.current = {
      kind: "pan",
      startClientX: e.clientX,
      startClientY: e.clientY,
      lastSvgX: p.x,
      lastSvgY: p.y,
      origOffsetX: 0,
      origOffsetY: 0,
      moved: false,
    };
    beginGesture(e);
  };

  const onNodePointerDown = (e: React.PointerEvent, device: PositionedDevice) => {
    e.stopPropagation();
    const p = toSvgPoint(e.clientX, e.clientY);
    const orig = nodeOffsets.get(device.id) ?? { x: 0, y: 0 };
    gestureRef.current = {
      kind: "node",
      nodeId: String(device.id),
      startClientX: e.clientX,
      startClientY: e.clientY,
      lastSvgX: p.x,
      lastSvgY: p.y,
      origOffsetX: orig.x,
      origOffsetY: orig.y,
      moved: false,
    };
    beginGesture(e);
  };

  const onGroupPointerDown = (e: React.PointerEvent, groupKey: string) => {
    e.stopPropagation();
    const p = toSvgPoint(e.clientX, e.clientY);
    gestureRef.current = {
      kind: "node",
      nodeId: groupKey,
      startClientX: e.clientX,
      startClientY: e.clientY,
      lastSvgX: p.x,
      lastSvgY: p.y,
      origOffsetX: 0,
      origOffsetY: 0,
      moved: false,
    };
    beginGesture(e);
  };

  const edgeDimmed = (a: number, b: number) =>
    focusSet !== null && !(focusSet.has(a) && focusSet.has(b));
  const nodeDimmed = (id: number) => focusSet !== null && !focusSet.has(id);

  const renderEdge = (
    key: string | number,
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    status: string,
    dimmed: boolean,
  ) => {
    const stroke =
      status === "active" ? "hsl(240, 5%, 65%)" : "hsl(240, 5%, 35%)";
    const dash = status === "active" ? "none" : "5,5";
    const opacity = dimmed ? 0.08 : 0.7;
    if (layoutMode === "orthogonal") {
      return (
        <path
          key={key}
          d={orthogonalPath(x1, y1, x2, y2)}
          fill="none"
          stroke={stroke}
          strokeWidth="2"
          strokeDasharray={dash}
          markerEnd="url(#arrowhead)"
          opacity={opacity}
          className="network-connection"
        />
      );
    }
    if (layoutMode === "bundled") {
      return (
        <path
          key={key}
          d={bundledPath(x1, y1, x2, y2)}
          fill="none"
          stroke={stroke}
          strokeWidth="1.6"
          strokeDasharray={dash}
          opacity={dimmed ? 0.08 : 0.55}
          className="network-connection"
        />
      );
    }
    return (
      <line
        key={key}
        x1={x1}
        y1={y1}
        x2={x2}
        y2={y2}
        stroke={stroke}
        strokeWidth="2"
        strokeDasharray={dash}
        markerEnd="url(#arrowhead)"
        opacity={opacity}
        className="network-connection"
      />
    );
  };

  const isMatrix = layoutMode === "matrix";

  return (
    <div
      ref={containerRef}
      className="relative w-full h-full bg-muted/20 rounded-lg overflow-hidden select-none"
    >
      {isMatrix ? (
        <div className="w-full h-full pt-16">
          <AdjacencyMatrix
            devices={devices}
            connections={connections}
            onDeviceClick={onDeviceClick}
          />
        </div>
      ) : (
        <svg
          ref={svgRef}
          data-testid="topology-svg"
          className="w-full h-full cursor-grab active:cursor-grabbing"
          style={{ touchAction: "none" }}
          viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
          preserveAspectRatio="xMidYMid meet"
          onPointerDown={onBackgroundPointerDown}
        >
          <defs>
            <marker
              id="arrowhead"
              markerWidth="10"
              markerHeight="7"
              refX="9"
              refY="3.5"
              orient="auto"
              fill="hsl(240, 5%, 65%)"
            >
              <polygon points="0 0, 10 3.5, 0 7" />
            </marker>
          </defs>

          <g transform={`translate(${pan.x} ${pan.y}) scale(${scale})`}>
            {/* Compound / community containers (§2A) */}
            {groups?.map((g) => {
              const pill = groupPillOf.get(g.id);
              return (
                <g key={g.id}>
                  <rect
                    x={g.x}
                    y={g.y}
                    width={g.w}
                    height={g.h}
                    rx={12}
                    fill="hsl(264, 83%, 57%)"
                    fillOpacity={0.06}
                    stroke="hsl(264, 83%, 57%)"
                    strokeOpacity={0.45}
                    strokeWidth={1.5}
                    strokeDasharray={layoutMode === "community" ? "6 4" : "none"}
                  />
                  {pill && (
                    <rect
                      x={pill.x}
                      y={pill.y}
                      width={pill.w}
                      height={pill.h}
                      rx={10}
                      fill="var(--card)"
                      stroke="hsl(264, 83%, 57%)"
                      strokeOpacity={0.45}
                    />
                  )}
                  <text
                    x={g.x + 12}
                    y={g.y + 20}
                    fontSize="12"
                    fontWeight={600}
                    fill="currentColor"
                    data-label="group"
                  >
                    {g.label}
                  </text>
                </g>
              );
            })}

            {/* Aggregated inter-group edges (§2C) */}
            {badgeLayout.map((a) => (
              <g key={a.key} opacity={0.9}>
                <line
                  x1={a.x1}
                  y1={a.y1}
                  x2={a.x2}
                  y2={a.y2}
                  stroke="hsl(264, 83%, 57%)"
                  strokeWidth={2 + Math.min(6, a.count)}
                  strokeLinecap="round"
                  opacity={0.55}
                />
                <g>
                  <rect
                    x={a.cx - a.pillW / 2}
                    y={a.cy - a.pillH / 2}
                    width={a.pillW}
                    height={a.pillH}
                    rx={11}
                    fill="hsl(222, 84%, 5%)"
                    stroke="hsl(264, 83%, 57%)"
                    strokeWidth={1}
                  />
                  <text
                    x={a.cx}
                    y={a.cy + 4}
                    textAnchor="middle"
                    fontSize="11"
                    fill="white"
                    data-label="badge"
                  >
                    {a.text}
                  </text>
                </g>
              </g>
            ))}

            {/* Connection lines */}
            <g>
              {individualEdges.map((connection) => {
                const fromDevice = deviceById.get(connection.fromDeviceId);
                const toDevice = deviceById.get(connection.toDeviceId);
                if (!fromDevice || !toDevice) return null;
                return renderEdge(
                  connection.id,
                  fromDevice.layoutX,
                  fromDevice.layoutY,
                  toDevice.layoutX,
                  toDevice.layoutY,
                  connection.status,
                  edgeDimmed(connection.fromDeviceId, connection.toDeviceId),
                );
              })}
            </g>

            {/* Collapsed community supernodes */}
            {layoutMode === "community" &&
              groups
                ?.filter((g) => collapsedGroupIds.has(g.id))
                .map((g) => {
                  const cx = g.x + g.w / 2;
                  const cy = g.y + g.h / 2;
                  const dim = focusSet !== null && !g.memberIds.some((id) => focusSet.has(id));
                  const caption = placements.get(`super:${g.id}`);
                  return (
                    <g
                      key={`super-${g.id}`}
                      className="network-node cursor-pointer"
                      opacity={dim ? 0.2 : 1}
                      onPointerDown={(e) => onGroupPointerDown(e, `group:${g.id}`)}
                      onClick={() => {
                        if (suppressClickRef.current) {
                          suppressClickRef.current = false;
                          return;
                        }
                        toggleCommunity(g.id);
                      }}
                    >
                      <title>{`${g.label} — click to expand`}</title>
                      <circle
                        cx={cx}
                        cy={cy}
                        r={34}
                        fill="hsl(264, 83%, 57%)"
                        stroke="white"
                        strokeWidth="3"
                      />
                      <text
                        x={cx}
                        y={cy + 1}
                        textAnchor="middle"
                        fill="white"
                        fontSize="15"
                        fontWeight={700}
                        className="pointer-events-none"
                        data-inside="true"
                      >
                        {g.memberIds.length}
                      </text>
                      {caption?.visible && (
                        <text
                          x={caption.x}
                          y={caption.y}
                          textAnchor={caption.anchor}
                          fill="currentColor"
                          fontSize={LABEL_FONT_SIZE}
                          className="pointer-events-none svg-text-halo"
                          data-label="super"
                        >
                          {g.label}
                        </text>
                      )}
                      {caption?.visible && caption.leader && (
                        <line
                          x1={caption.edgeX}
                          y1={caption.edgeY}
                          x2={caption.x}
                          y2={caption.y}
                          stroke="currentColor"
                          strokeOpacity={0.4}
                          strokeWidth={1}
                        />
                      )}
                    </g>
                  );
                })}

            {/* Device nodes */}
            <g>
              {visibleDevices.map((device) => {
                const radius = nodeRadius(device);
                const dim = nodeDimmed(device.id);
                const label = placements.get(`node:${device.id}`);
                const sub = subLabels.get(device.id);

                return (
                  <g
                    key={device.id}
                    className="network-node cursor-pointer"
                    opacity={dim ? 0.15 : 1}
                    onPointerDown={(e) => onNodePointerDown(e, device)}
                    onClick={() => handleDeviceClick(device)}
                    onMouseEnter={() => setFocusId(device.id)}
                    onMouseLeave={() =>
                      setFocusId((prev) => (prev === device.id ? null : prev))
                    }
                  >
                    <title>{`${device.name} (${device.ipAddress})`}</title>
                    <circle
                      cx={device.layoutX}
                      cy={device.layoutY}
                      r={radius}
                      fill={
                        device.isCoordinator
                          ? "var(--tailscale-purple)"
                          : getStatusColor(device.status)
                      }
                      stroke={
                        focusSet?.has(device.id) && focusId !== device.id
                          ? "hsl(264, 83%, 70%)"
                          : "white"
                      }
                      strokeWidth={
                        focusSet?.has(device.id) && focusId !== device.id ? 4 : 3
                      }
                      style={{
                        animation:
                          device.status === "unstable"
                            ? "pulse 2s infinite"
                            : "none",
                        opacity: device.status === "disconnected" ? 0.5 : 1,
                      }}
                    />

                    {/* Device emoji */}
                    <text
                      x={device.layoutX}
                      y={device.layoutY + 3}
                      textAnchor="middle"
                      fill="white"
                      fontSize="14"
                      className="pointer-events-none"
                      data-inside="true"
                    >
                      {getDeviceEmoji(
                        device.deviceType,
                        device.isCoordinator ?? false,
                      )}
                    </text>

                    {/* Device label (deconflicted; hidden when zoomed out) */}
                    {showLabels && label?.visible && (
                      <text
                        x={label.x}
                        y={label.y}
                        textAnchor={label.anchor}
                        fill="currentColor"
                        fontSize={LABEL_FONT_SIZE}
                        className="pointer-events-none svg-text-halo"
                        data-label="node"
                      >
                        {device.name}
                      </text>
                    )}
                    {showLabels && label?.visible && label.leader && (
                      <line
                        x1={label.edgeX}
                        y1={label.edgeY}
                        x2={label.x}
                        y2={label.y}
                        stroke="currentColor"
                        strokeOpacity={0.4}
                        strokeWidth={1}
                      />
                    )}
                    {showLabels && sub && (
                      <text
                        x={sub.x}
                        y={sub.y}
                        textAnchor="middle"
                        fill="currentColor"
                        opacity={0.6}
                        fontSize="10"
                        fontFamily="monospace"
                        className="pointer-events-none svg-text-halo"
                        data-label="node-sub"
                      >
                        {device.ipAddress}
                      </text>
                    )}
                  </g>
                );
              })}
            </g>

            {/* Constraint-mode column headers */}
            {layoutMode === "constraint" && (
              <g opacity={0.7}>
                {["server", "desktop", "mobile", "other"]
                  .filter((col) =>
                    positionedDevices.some(
                      (d) =>
                        (d.deviceType === col ||
                          (col === "other" &&
                            !["server", "desktop", "mobile"].includes(
                              d.deviceType,
                            ))),
                    ),
                  )
                  .map((col) => {
                    const xs = positionedDevices
                      .filter(
                        (d) =>
                          d.deviceType === col ||
                          (col === "other" &&
                            !["server", "desktop", "mobile"].includes(
                              d.deviceType,
                            )),
                      )
                      .map((d) => d.layoutX);
                    const x = xs.length
                      ? xs.reduce((s, v) => s + v, 0) / xs.length
                      : VIEW_W / 2;
                    return (
                      <text
                        key={col}
                        x={x}
                        y={34}
                        textAnchor="middle"
                        fontSize="12"
                        fontWeight={600}
                        fill="currentColor"
                        className="svg-text-halo"
                        data-label="header"
                        style={{ textTransform: "capitalize" }}
                      >
                        {col}
                      </text>
                    );
                  })}
              </g>
            )}
          </g>
        </svg>
      )}

      {/* Visualization picker */}
      <div className="absolute top-4 left-4 w-64">
        <Card className="p-3 space-y-2">
          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Visualization
          </p>
          <Select
            value={layoutMode}
            onValueChange={(v) => setLayoutMode(v as LayoutMode)}
          >
            <SelectTrigger aria-label="Choose visualization method">
              <SelectValue placeholder="Choose layout" />
            </SelectTrigger>
            <SelectContent>
              {LAYOUTS.map((l) => (
                <SelectItem key={l.id} value={l.id}>
                  {l.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground leading-snug">
            <span className="font-medium text-foreground">
              {activeLayout.subtitle}
            </span>
            {" — "}
            {activeLayout.description}
          </p>
          {!isMatrix && (
            <div className="space-y-2 pt-1">
              <label className="flex items-center justify-between gap-2 text-xs">
                <span>Aggregate inter-group edges</span>
                <Switch
                  checked={aggregate}
                  onCheckedChange={setAggregate}
                  aria-label="Aggregate inter-group edges"
                />
              </label>
              <label className="flex items-center justify-between gap-2 text-xs">
                <span>Highlight neighbors on hover</span>
                <Switch
                  checked={focusOn}
                  onCheckedChange={setFocusOn}
                  aria-label="Highlight neighbors on hover"
                />
              </label>
              {layoutMode === "community" && (
                <div className="flex gap-2 pt-1">
                  <Button
                    variant="outline"
                    size="sm"
                    className="flex-1 h-7 text-xs"
                    onClick={expandAll}
                  >
                    Expand all
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    className="flex-1 h-7 text-xs"
                    onClick={collapseAll}
                  >
                    Collapse
                  </Button>
                </div>
              )}
            </div>
          )}
        </Card>
      </div>

      {/* Controls */}
      {!isMatrix && (
        <div className="absolute top-4 right-4 flex flex-col space-y-2">
          <Button variant="outline" size="icon" onClick={handleZoomIn} aria-label="Zoom in">
            <ZoomIn className="h-4 w-4" />
          </Button>
          <Button variant="outline" size="icon" onClick={handleZoomOut} aria-label="Zoom out">
            <ZoomOut className="h-4 w-4" />
          </Button>
          <Button
            variant="outline"
            size="icon"
            onClick={handleResetView}
            aria-label="Reset view"
          >
            <Maximize2 className="h-4 w-4" />
          </Button>
          <Button
            variant="outline"
            size="icon"
            onClick={handleResetLayout}
            aria-label="Reset layout"
          >
            <RotateCcw className="h-4 w-4" />
          </Button>
        </div>
      )}

      {/* Legend */}
      {!isMatrix && (
        <div className="absolute bottom-4 left-4">
          <Card className="p-4">
            <h4 className="text-sm font-medium mb-3">Legend</h4>
            <div className="space-y-2">
              <div className="flex items-center space-x-2">
                <div className="w-4 h-4 bg-connected-green rounded-full" />
                <span className="text-xs">Connected</span>
              </div>
              <div className="flex items-center space-x-2">
                <div className="w-4 h-4 bg-warning-yellow rounded-full" />
                <span className="text-xs">Unstable</span>
              </div>
              <div className="flex items-center space-x-2">
                <div className="w-4 h-4 bg-muted rounded-full" />
                <span className="text-xs">Offline</span>
              </div>
              <div className="flex items-center space-x-2">
                <div className="w-4 h-4 bg-tailscale-purple rounded-full" />
                <span className="text-xs">Coordinator</span>
              </div>
            </div>
          </Card>
        </div>
      )}

      <p className="absolute bottom-4 right-4 text-xs text-muted-foreground pointer-events-none">
        {isMatrix
          ? "Drag to pan • scroll to zoom • click a device to inspect it"
          : layoutMode === "community"
            ? "Click a cluster to expand/collapse • drag to pan • scroll to zoom"
            : "Hover to highlight neighbors • drag to pan • drag a node to move it • scroll to zoom"}
      </p>

      {/* Status for screen readers */}
      <span className="sr-only">
        {positionedDevices.length} devices shown with {activeLayout.label} layout
      </span>
    </div>
  );
}
