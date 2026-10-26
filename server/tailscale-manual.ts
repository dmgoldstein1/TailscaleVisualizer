// Manual Tailscale data import - alternative to API
import type { InsertDevice } from "@shared/schema";
import { promises as fs } from "fs";
import path from "path";

export interface ManualTailscaleConfig {
  devices: {
    name: string;
    hostname: string;
    ipAddress: string;
    os?: string;
    deviceType?: string;
    online?: boolean;
    tags?: string[];
  }[];
}

export class TailscaleManualImporter {
  private configPath = path.join(process.cwd(), 'tailscale-devices.json');

  async loadDevicesFromFile(): Promise<InsertDevice[]> {
    try {
      const fileContent = await fs.readFile(this.configPath, 'utf-8');
      const config: ManualTailscaleConfig = JSON.parse(fileContent);
      
      return config.devices.map((device, index) => ({
        name: device.name,
        hostname: device.hostname,
        tailscaleId: `manual-${index + 1}`,
        ipAddress: device.ipAddress,
        deviceType: device.deviceType || this.guessDeviceType(device.name),
        os: device.os || 'Unknown',
        status: device.online ? 'connected' : 'disconnected',
        tags: device.tags || [],
        isCoordinator: index === 0 // First device is coordinator
      }));
    } catch (error) {
      console.log('No manual device configuration found');
      return [];
    }
  }

  private guessDeviceType(name: string): string {
    const lower = name.toLowerCase();
    if (lower.includes('server')) return 'server';
    if (lower.includes('phone') || lower.includes('mobile')) return 'mobile';
    if (lower.includes('laptop') || lower.includes('macbook')) return 'desktop';
    return 'other';
  }

  async saveDevicesToFile(devices: Array<Record<string, unknown>>): Promise<void> {
    const config: ManualTailscaleConfig = {
      devices: devices.map((d) => ({
        name: String(d.name ?? "unknown"),
        hostname: String(d.hostname ?? d.name ?? "unknown"),
        ipAddress: String(
          d.ipAddress ?? (Array.isArray(d.addresses) ? d.addresses[0] : undefined) ?? "Unknown",
        ),
        os: typeof d.os === "string" ? d.os : undefined,
        deviceType: typeof d.deviceType === "string" ? d.deviceType : undefined,
        online: Boolean(d.online ?? d.status === "connected"),
        tags: Array.isArray(d.tags) ? (d.tags as string[]) : [],
      })),
    };
    
    await fs.writeFile(this.configPath, JSON.stringify(config, null, 2));
  }
}

// Alternative: Import from Tailscale export
export async function importFromTailscaleExport(exportData: string): Promise<InsertDevice[]> {
  try {
    const data = JSON.parse(exportData) as {
      devices?: Array<Record<string, unknown>>;
      Peers?: Record<string, Record<string, unknown>>;
    };
    const devices: InsertDevice[] = [];

    // Handle different export formats
    if (Array.isArray(data.devices)) {
      // Direct device list
      data.devices.forEach((device, index) => {
        const name = String(device.name ?? device.hostname ?? `Device ${index + 1}`);
        const hostname = String(device.hostname ?? device.name ?? name);
        const addresses = Array.isArray(device.addresses)
          ? (device.addresses as unknown[]).map(String)
          : [];
        const os = typeof device.os === "string" ? device.os : "Unknown";
        devices.push({
          name,
          hostname,
          tailscaleId: String(device.id ?? `import-${index + 1}`),
          ipAddress: addresses[0] ?? (typeof device.ipAddress === "string" ? device.ipAddress : `100.64.0.${index + 1}`),
          deviceType: os.toLowerCase().includes('linux') ? 'server' : 'desktop',
          os,
          status: device.online ? 'connected' : 'disconnected',
          tags: Array.isArray(device.tags) ? (device.tags as string[]) : [],
          isCoordinator: Boolean(device.isExitNode)
        });
      });
    } else if (data.Peers && typeof data.Peers === "object") {
      // Tailscale status format
      Object.entries(data.Peers).forEach(([id, peer], index) => {
        const hostName = typeof peer.HostName === "string" ? peer.HostName : undefined;
        const dnsName = typeof peer.DNSName === "string" ? peer.DNSName : undefined;
        const ips = Array.isArray(peer.TailscaleIPs)
          ? (peer.TailscaleIPs as unknown[]).map(String)
          : [];
        const os = typeof peer.OS === "string" ? peer.OS : "Unknown";
        const name = hostName ?? dnsName?.split('.')[0] ?? `Device ${index + 1}`;
        devices.push({
          name,
          hostname: dnsName ?? hostName ?? name,
          tailscaleId: id,
          ipAddress: ips[0] ?? `100.64.0.${index + 1}`,
          deviceType: os.toLowerCase().includes('linux') ? 'server' : 'desktop',
          os,
          status: peer.Online ? 'connected' : 'disconnected',
          tags: Array.isArray(peer.Tags) ? (peer.Tags as string[]) : [],
          isCoordinator: Boolean(peer.ExitNode)
        });
      });
    }

    return devices;
  } catch (error) {
    console.error('Failed to parse Tailscale export:', error);
    throw new Error('Invalid Tailscale export format');
  }
}