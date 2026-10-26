import { useMemo, useRef, useState } from "react";
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

export function NetworkTopology({
  devices,
  connections,
  onDeviceClick,
}: NetworkTopologyProps) {
  const svgRef = useRef<SVGSVGElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);

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
  // Devices with persisted x/y keep them; others get a circle layout.
  const positionedDevices: PositionedDevice[] = useMemo(() => {
    const width = containerRef.current?.clientWidth || 800;
    const height = containerRef.current?.clientHeight || 600;
    const cx = width / 2;
    const cy = height / 2;

    const coordinator = devices.find((d) => d.isCoordinator);
    const others = devices.filter((d) => !d.isCoordinator);
    const radius = Math.min(width, height) * 0.3;

    const positions = new Map<number, { x: number; y: number }>();
    if (coordinator) {
      positions.set(coordinator.id, {
        x: coordinator.x || cx,
        y: coordinator.y || cy,
      });
    }
    others.forEach((device, index) => {
      if (device.x && device.y) {
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

    return devices.map((d) => ({
      ...d,
      layoutX: positions.get(d.id)?.x ?? cx,
      layoutY: positions.get(d.id)?.y ?? cy,
    }));
  }, [devices]);

  const deviceById = useMemo(
    () => new Map(positionedDevices.map((d) => [d.id, d])),
    [positionedDevices],
  );

  const handleDeviceClick = (device: Device) => {
    onDeviceClick(device);
  };

  const handleZoomIn = () => {
    setScale((s) => Math.min(2.5, Number((s + 0.2).toFixed(2))));
  };

  const handleZoomOut = () => {
    setScale((s) => Math.max(0.5, Number((s - 0.2).toFixed(2))));
  };

  const handleReset = () => {
    setScale(1);
  };

  return (
    <div
      ref={containerRef}
      className="relative w-full h-full bg-muted/20 rounded-lg overflow-hidden"
    >
      {/* Network Topology SVG */}
      <svg
        ref={svgRef}
        className="w-full h-full"
        viewBox="0 0 800 600"
        preserveAspectRatio="xMidYMid meet"
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

        <g transform={`translate(400 300) scale(${scale}) translate(-400 -300)`}>
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
                <g key={device.id} className="network-node">
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
                    className="cursor-pointer"
                    onClick={() => handleDeviceClick(device)}
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
          onClick={handleReset}
          aria-label="Reset view"
        >
          <Maximize2 className="h-4 w-4" />
        </Button>
        <Button
          variant="outline"
          size="icon"
          onClick={handleReset}
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

      {/* Status for screen readers */}
      <span className="sr-only">
        {positionedDevices.length} devices shown
      </span>
    </div>
  );
}
