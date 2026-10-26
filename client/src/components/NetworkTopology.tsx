import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ZoomIn, ZoomOut, Maximize2, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
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

const VIEW_W = 800;
const VIEW_H = 600;
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

  // Active gesture bookkeeping (refs so handlers stay fresh without re-binding)
  const gestureRef = useRef<
    | {
        kind: "pan" | "node";
        nodeId?: number;
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

  // Compute layout without mutating props (devices come from React Query cache).
  // Layout is computed in viewBox units (not screen pixels) so nodes always
  // land inside the visible 800x600 area regardless of container size.
  // Devices with persisted x/y keep them (when in range); others get a
  // circle layout. Dragged nodes add their local offset on top.
  const positionedDevices: PositionedDevice[] = useMemo(() => {
    const cx = VIEW_W / 2;
    const cy = VIEW_H / 2;

    const coordinator = devices.find((d) => d.isCoordinator);
    const others = devices.filter((d) => !d.isCoordinator);
    const radius = Math.min(VIEW_W, VIEW_H) * 0.3;

    const positions = new Map<number, { x: number; y: number }>();
    if (coordinator) {
      positions.set(
        coordinator.id,
        hasUsablePosition(coordinator)
          ? { x: coordinator.x, y: coordinator.y }
          : { x: cx, y: cy },
      );
    }
    others.forEach((device, index) => {
      if (hasUsablePosition(device)) {
        positions.set(device.id, { x: device.x, y: device.y });
      } else {
        const angle =
          others.length > 0 ? (index / others.length) * 2 * Math.PI : 0;
        positions.set(device.id, {
          x: cx + Math.cos(angle) * radius,
          y: cy + Math.sin(angle) * radius,
        });
      }
    });

    return devices.map((d) => {
      const base = positions.get(d.id) ?? { x: cx, y: cy };
      const offset = nodeOffsets.get(d.id);
      return {
        ...d,
        layoutX: base.x + (offset?.x ?? 0),
        layoutY: base.y + (offset?.y ?? 0),
      };
    });
  }, [devices, nodeOffsets]);

  const deviceById = useMemo(
    () => new Map(positionedDevices.map((d) => [d.id, d])),
    [positionedDevices],
  );

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
        const nodeId = g.nodeId;
        g.origOffsetX += dx / ds;
        g.origOffsetY += dy / ds;
        setNodeOffsets((prev) => {
          const next = new Map(prev);
          next.set(nodeId, { x: g.origOffsetX, y: g.origOffsetY });
          return next;
        });
      }
    },
    [toSvgPoint],
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
    if (!svg) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      zoomAt(e.clientX, e.clientY, e.deltaY < 0 ? 1.15 : 1 / 1.15);
    };
    svg.addEventListener("wheel", onWheel, { passive: false });
    return () => svg.removeEventListener("wheel", onWheel);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
      nodeId: device.id,
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

  return (
    <div
      ref={containerRef}
      className="relative w-full h-full bg-muted/20 rounded-lg overflow-hidden select-none"
    >
      {/* Network Topology SVG */}
      <svg
        ref={svgRef}
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
          {/* Connection lines */}
          <g>
            {connections.map((connection) => {
              const fromDevice = deviceById.get(connection.fromDeviceId);
              const toDevice = deviceById.get(connection.toDeviceId);

              if (!fromDevice || !toDevice) return null;

              return (
                <line
                  key={connection.id}
                  x1={fromDevice.layoutX}
                  y1={fromDevice.layoutY}
                  x2={toDevice.layoutX}
                  y2={toDevice.layoutY}
                  stroke={
                    connection.status === "active"
                      ? "hsl(240, 5%, 65%)"
                      : "hsl(240, 5%, 35%)"
                  }
                  strokeWidth="2"
                  strokeDasharray={
                    connection.status === "active" ? "none" : "5,5"
                  }
                  markerEnd="url(#arrowhead)"
                  opacity="0.7"
                  className="network-connection"
                />
              );
            })}
          </g>

          {/* Device nodes */}
          <g>
            {positionedDevices.map((device) => {
              const radius = device.isCoordinator
                ? 30
                : device.deviceType === "server"
                  ? 25
                  : device.deviceType === "mobile"
                    ? 20
                    : 22;

              return (
                <g
                  key={device.id}
                  className="network-node cursor-pointer"
                  onPointerDown={(e) => onNodePointerDown(e, device)}
                  onClick={() => handleDeviceClick(device)}
                >
                  <circle
                    cx={device.layoutX}
                    cy={device.layoutY}
                    r={radius}
                    fill={
                      device.isCoordinator
                        ? "var(--tailscale-purple)"
                        : getStatusColor(device.status)
                    }
                    stroke="white"
                    strokeWidth="3"
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
                  >
                    {getDeviceEmoji(
                      device.deviceType,
                      device.isCoordinator ?? false,
                    )}
                  </text>

                  {/* Device label */}
                  <text
                    x={device.layoutX}
                    y={device.layoutY + radius + 20}
                    textAnchor="middle"
                    fill="currentColor"
                    fontSize="12"
                    className="pointer-events-none"
                  >
                    {device.name}
                  </text>
                </g>
              );
            })}
          </g>
        </g>
      </svg>

      {/* Controls */}
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

      {/* Legend */}
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

      <p className="absolute bottom-4 right-4 text-xs text-muted-foreground pointer-events-none">
        Drag to pan • drag a node to move it • scroll to zoom
      </p>

      {/* Status for screen readers */}
      <span className="sr-only">
        {positionedDevices.length} devices shown
      </span>
    </div>
  );
}
