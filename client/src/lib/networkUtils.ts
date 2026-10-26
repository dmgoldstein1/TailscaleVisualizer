import type { Device, Connection } from "@shared/schema";

export interface NetworkNode {
  id: string;
  device: Device;
  x: number;
  y: number;
  vx?: number;
  vy?: number;
}

export interface NetworkLink {
  source: string;
  target: string;
  connection: Connection;
}

export function createNetworkGraph(
  devices: Device[],
  connections: Connection[],
) {
  const nodes: NetworkNode[] = devices.map((device) => ({
    id: device.id.toString(),
    device,
    x: device.x || Math.random() * 800,
    y: device.y || Math.random() * 600,
  }));

  const links: NetworkLink[] = connections.map((connection) => ({
    source: connection.fromDeviceId.toString(),
    target: connection.toDeviceId.toString(),
    connection,
  }));

  return { nodes, links };
}

export function calculateForceDirectedLayout(
  nodes: NetworkNode[],
  links: NetworkLink[],
  width: number,
  height: number,
) {
  const iterations = 100;
  const k = Math.sqrt((width * height) / nodes.length);
  const repulsionStrength = k * k;
  const attractionStrength = k;

  for (let i = 0; i < iterations; i++) {
    // Apply repulsion between all nodes
    for (let j = 0; j < nodes.length; j++) {
      const node1 = nodes[j];
      node1.vx = node1.vx || 0;
      node1.vy = node1.vy || 0;

      for (let k = j + 1; k < nodes.length; k++) {
        const node2 = nodes[k];
        node2.vx = node2.vx || 0;
        node2.vy = node2.vy || 0;

        const dx = node1.x - node2.x;
        const dy = node1.y - node2.y;
        const distance = Math.sqrt(dx * dx + dy * dy) || 1;

        const force = repulsionStrength / distance;
        const fx = (dx / distance) * force;
        const fy = (dy / distance) * force;

        node1.vx += fx;
        node1.vy += fy;
        node2.vx -= fx;
        node2.vy -= fy;
      }
    }

    // Apply attraction between connected nodes
    for (const link of links) {
      const source = nodes.find((n) => n.id === link.source);
      const target = nodes.find((n) => n.id === link.target);

      if (source && target) {
        const dx = target.x - source.x;
        const dy = target.y - source.y;
        const distance = Math.sqrt(dx * dx + dy * dy) || 1;

        const force = (distance * distance) / attractionStrength;
        const fx = (dx / distance) * force;
        const fy = (dy / distance) * force;

        source.vx = (source.vx || 0) + fx;
        source.vy = (source.vy || 0) + fy;
        target.vx = (target.vx || 0) - fx;
        target.vy = (target.vy || 0) - fy;
      }
    }

    // Update positions
    for (const node of nodes) {
      node.x += (node.vx || 0) * 0.1;
      node.y += (node.vy || 0) * 0.1;

      // Apply damping
      node.vx = (node.vx || 0) * 0.9;
      node.vy = (node.vy || 0) * 0.9;

      // Keep nodes within bounds
      node.x = Math.max(50, Math.min(width - 50, node.x));
      node.y = Math.max(50, Math.min(height - 50, node.y));
    }
  }

  return nodes;
}

export function getDeviceStatusColor(status: string): string {
  switch (status) {
    case "connected":
      return "#10B981";
    case "unstable":
      return "#F59E0B";
    case "disconnected":
      return "#6B7280";
    default:
      return "#6B7280";
  }
}

export function getDeviceIcon(
  deviceType: string,
  isCoordinator: boolean,
): string {
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
}

/**
 * Tailnet name shown in the header. Prefers the coordinator hostname,
 * then the parent domain of any device hostname *or* name (the real API
 * returns short hostnames like "laptop" but FQDN names like
 * "laptop.my-tailnet.ts.net"), then the configured tailnet name, and
 * only then the demo fallback — so real tailnets never display
 * "demo-tailnet.ts.net".
 */
export function getTailnetDisplay(
  devices: Pick<Device, "hostname" | "name" | "isCoordinator">[],
  configuredTailnet?: string | null,
): string {
  const coordinator = devices.find((d) => d.isCoordinator)?.hostname;
  if (coordinator) return coordinator;

  const dotted = devices
    .flatMap((d) => [d.hostname, d.name])
    .find((h) => h.includes("."));
  if (dotted) return dotted.split(".").slice(1).join(".");

  if (configuredTailnet) {
    return configuredTailnet.includes(".")
      ? configuredTailnet
      : `${configuredTailnet}.ts.net`;
  }
  return "demo-tailnet.ts.net";
}
