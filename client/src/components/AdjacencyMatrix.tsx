import { useEffect, useMemo, useRef, useState } from "react";
import { ZoomIn, ZoomOut, Maximize2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { Device, Connection } from "@shared/schema";

interface AdjacencyMatrixProps {
  devices: Device[];
  connections: Connection[];
  onDeviceClick: (device: Device) => void;
}

const MIN_SCALE = 0.5;
const MAX_SCALE = 3;
const CLICK_DRAG_THRESHOLD_PX = 5;

/**
 * Adjacency-matrix visualization (§5 of Graph-Drawing-Algorithms.md):
 * a grid of senders × receivers that stays legible for dense
 * many-to-many relationships where drawing every line would be spaghetti.
 *
 * Like every other visualization here it supports pan (drag the
 * background) and zoom (scroll wheel / buttons). Headers live in their
 * own grid cells so they can never overlap each other; row labels are
 * truncated with full names in tooltips.
 */
export function AdjacencyMatrix({
  devices,
  connections,
  onDeviceClick,
}: AdjacencyMatrixProps) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [mScale, setMScale] = useState(1);
  const [mPan, setMPan] = useState({ x: 0, y: 0 });
  const gestureRef = useRef<{
    startClientX: number;
    startClientY: number;
    lastX: number;
    lastY: number;
    moved: boolean;
  } | null>(null);

  const sorted = useMemo(
    () => [...devices].sort((a, b) => a.name.localeCompare(b.name)),
    [devices],
  );

  const { activeSet, inactiveSet, colCounts } = useMemo(() => {
    const active = new Set<string>();
    const inactive = new Set<string>();
    for (const c of connections) {
      const key = `${c.fromDeviceId}>${c.toDeviceId}`;
      const rev = `${c.toDeviceId}>${c.fromDeviceId}`;
      if (c.status === "active") {
        active.add(key);
        active.add(rev);
      } else {
        inactive.add(key);
        inactive.add(rev);
      }
    }
    const counts = new Map<number, number>();
    for (const d of sorted) {
      let n = 0;
      for (const o of sorted) {
        if (active.has(`${d.id}>${o.id}`) || inactive.has(`${d.id}>${o.id}`))
          n += 1;
      }
      counts.set(d.id, n);
    }
    return { activeSet: active, inactiveSet: inactive, colCounts: counts };
  }, [connections, sorted]);

  const zoomAt = (clientX: number, clientY: number, factor: number) => {
    const el = wrapRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const cx = clientX - rect.left;
    const cy = clientY - rect.top;
    setMScale((s) => {
      const next = Math.min(
        MAX_SCALE,
        Math.max(MIN_SCALE, Number((s * factor).toFixed(3))),
      );
      if (next === s) return s;
      const k = next / s;
      setMPan((p) => ({
        x: cx - k * (cx - p.x),
        y: cy - k * (cy - p.y),
      }));
      return next;
    });
  };

  const zoomCenter = (factor: number) => {
    const el = wrapRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    zoomAt(r.x + r.width / 2, r.y + r.height / 2, factor);
  };

  // Wheel zoom (native listener: React's onWheel is passive).
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      zoomAt(e.clientX, e.clientY, e.deltaY < 0 ? 1.15 : 1 / 1.15);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Background pan; drags starting on a button are left alone so device
  // buttons stay clickable after any pointer movement.
  const onPointerDown = (e: React.PointerEvent) => {
    if ((e.target as HTMLElement).closest("button")) return;
    gestureRef.current = {
      startClientX: e.clientX,
      startClientY: e.clientY,
      lastX: e.clientX,
      lastY: e.clientY,
      moved: false,
    };
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    e.preventDefault();
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const g = gestureRef.current;
    if (!g) return;
    if (
      Math.hypot(e.clientX - g.startClientX, e.clientY - g.startClientY) >
      CLICK_DRAG_THRESHOLD_PX
    ) {
      g.moved = true;
    }
    if (!g.moved) return;
    const dx = e.clientX - g.lastX;
    const dy = e.clientY - g.lastY;
    g.lastX = e.clientX;
    g.lastY = e.clientY;
    setMPan((p) => ({ x: p.x + dx, y: p.y + dy }));
  };
  const onPointerUp = () => {
    gestureRef.current = null;
  };

  if (sorted.length === 0) {
    return (
      <div className="w-full h-full flex items-center justify-center text-sm text-muted-foreground">
        No devices to display.
      </div>
    );
  }

  const N = sorted.length;
  // Fit the matrix in the viewport; cap cell size for large tailnets.
  const maxPx = 560;
  const cell = Math.max(10, Math.min(36, Math.floor(maxPx / (N + 1))));
  const labelW = Math.min(140, Math.max(70, cell * 4));

  // Column headers: horizontal only when the longest name provably fits
  // in one cell; otherwise vertical (one glyph row per column, so adjacent
  // headers can never overlap). Full names always survive in tooltips.
  const headerFont = 11;
  const maxNameLen = Math.max(...sorted.map((d) => d.name.length), 1);
  const horizFits = maxNameLen * headerFont * 0.65 + 6 <= cell;
  const verticalHeaderH = Math.ceil(maxNameLen * headerFont * 1.15) + 12;

  return (
    <div
      ref={wrapRef}
      className="relative w-full h-full overflow-hidden cursor-grab active:cursor-grabbing"
      style={{ touchAction: "none" }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
    >
      <div
        data-testid="matrix-viewport"
        className="absolute left-0 top-0 p-4"
        style={{
          transform: `translate(${mPan.x}px, ${mPan.y}px) scale(${mScale})`,
          transformOrigin: "0 0",
        }}
      >
        <div
          className="mx-auto"
          style={{ width: labelW + cell * N + 8 }}
          role="table"
          aria-label={`Adjacency matrix of ${N} devices`}
        >
          {/* Column headers */}
          <div className="flex" role="row">
            <div style={{ width: labelW }} className="shrink-0" />
            {sorted.map((d) =>
              horizFits ? (
                <button
                  key={d.id}
                  type="button"
                  title={`${d.name} (${d.ipAddress}) — ${colCounts.get(d.id) ?? 0} links`}
                  onClick={() => onDeviceClick(d)}
                  className="shrink-0 text-muted-foreground hover:text-foreground truncate"
                  style={{ width: cell, fontSize: headerFont, height: 20 }}
                  role="columnheader"
                >
                  {d.name}
                </button>
              ) : (
                <button
                  key={d.id}
                  type="button"
                  title={`${d.name} (${d.ipAddress}) — ${colCounts.get(d.id) ?? 0} links`}
                  onClick={() => onDeviceClick(d)}
                  className="shrink-0 text-muted-foreground hover:text-foreground overflow-hidden"
                  style={{
                    width: cell,
                    fontSize: headerFont,
                    writingMode: "vertical-rl",
                    height: verticalHeaderH,
                    lineHeight: 1.15,
                  }}
                  role="columnheader"
                >
                  {d.name}
                </button>
              ),
            )}
          </div>
          {sorted.map((row) => (
            <div key={row.id} className="flex items-center" role="row">
              <button
                type="button"
                onClick={() => onDeviceClick(row)}
                title={`${row.name} (${row.ipAddress})`}
                className="shrink-0 text-left truncate text-xs hover:text-primary pr-2"
                style={{ width: labelW }}
                role="rowheader"
              >
                {row.name}
              </button>
              {sorted.map((col) => {
                const isSelf = row.id === col.id;
                const key = `${row.id}>${col.id}`;
                const isActive = activeSet.has(key);
                const isInactive = !isActive && inactiveSet.has(key);
                return (
                  <div
                    key={col.id}
                    role="cell"
                    aria-label={
                      isSelf
                        ? `${row.name} to itself`
                        : isActive
                          ? `${row.name} actively connected to ${col.name}`
                          : isInactive
                            ? `${row.name} inactive link to ${col.name}`
                            : `${row.name} not connected to ${col.name}`
                    }
                    title={
                      isSelf
                        ? "—"
                        : isActive
                          ? `${row.name} ↔ ${col.name} (active)`
                          : isInactive
                            ? `${row.name} ↔ ${col.name} (inactive)`
                            : "no link"
                    }
                    style={{ width: cell, height: cell }}
                    className={`shrink-0 border border-border/60 ${
                      isSelf
                        ? "bg-muted/40"
                        : isActive
                          ? "bg-connected-green"
                          : isInactive
                            ? "bg-warning-yellow/50"
                            : "bg-muted/20"
                    }`}
                  />
                );
              })}
            </div>
          ))}
          <div className="mt-3 flex flex-wrap items-center gap-4 text-xs text-muted-foreground">
            <span className="flex items-center gap-1.5">
              <span className="h-3 w-3 rounded-sm bg-connected-green inline-block" />
              Active link
            </span>
            <span className="flex items-center gap-1.5">
              <span className="h-3 w-3 rounded-sm bg-warning-yellow/50 inline-block" />
              Inactive link
            </span>
            <span className="flex items-center gap-1.5">
              <span className="h-3 w-3 rounded-sm bg-muted/20 border border-border/60 inline-block" />
              No link
            </span>
            <span>
              {connections.length} links · {N} devices
            </span>
          </div>
        </div>
      </div>

      {/* Pan/zoom controls */}
      <div
        className="absolute top-4 right-4 flex flex-col space-y-2"
        onPointerDown={(e) => e.stopPropagation()}
      >
        <Button
          variant="outline"
          size="icon"
          onClick={() => zoomCenter(1.2)}
          aria-label="Zoom in"
        >
          <ZoomIn className="h-4 w-4" />
        </Button>
        <Button
          variant="outline"
          size="icon"
          onClick={() => zoomCenter(1 / 1.2)}
          aria-label="Zoom out"
        >
          <ZoomOut className="h-4 w-4" />
        </Button>
        <Button
          variant="outline"
          size="icon"
          onClick={() => {
            setMScale(1);
            setMPan({ x: 0, y: 0 });
          }}
          aria-label="Reset view"
        >
          <Maximize2 className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}
