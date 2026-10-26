import type { InsertDevice, NetworkStats } from "@shared/schema";
import {
  getEffectiveTailscaleConfig,
  getTailscaleConfigStatus,
} from "./runtime-config";

export interface TailscaleDevice {
  id: string;
  name: string;
  hostname: string;
  clientVersion: string;
  os: string;
  addresses?: string[];
  machineKey: string;
  nodeKey: string;
  created: string;
  // NOTE: the real API has no `online` field. Presence is signalled by
  // `connectedToControl` (Oct 2025+), and `lastSeen` is only included
  // when `connectedToControl` is false. `online` is kept optional for
  // older/alternate payload shapes (e.g. `tailscale status` peers).
  lastSeen?: string | null;
  online?: boolean;
  connectedToControl?: boolean;
  isExternal: boolean;
  updateAvailable: boolean;
  tags?: string[];
  expires: string;
  keyExpiryDisabled: boolean;
  authorized: boolean;
  user: string;
  tailnetLockKey: string;
  tailnetLockError: string;
  enabledServices: string[];
  advertiseExitNode: boolean;
  advertiseRoutes: string[];
  blocksIncomingConnections: boolean;
}

export type DevicePresence = "connected" | "disconnected" | "unstable";

const CONNECTED_RECENCY_MINUTES = 5;
const UNSTABLE_RECENCY_MINUTES = 30;

function statusFromLastSeen(lastSeen?: string | null): DevicePresence {
  if (!lastSeen) return "disconnected";
  const seenAt = new Date(lastSeen).getTime();
  if (Number.isNaN(seenAt)) return "disconnected";
  const minutesSinceSeen = (Date.now() - seenAt) / (1000 * 60);
  if (minutesSinceSeen <= CONNECTED_RECENCY_MINUTES) return "connected";
  if (minutesSinceSeen <= UNSTABLE_RECENCY_MINUTES) return "unstable";
  return "disconnected";
}

/**
 * Derive presence from whatever shape the data arrives in.
 * Prefer the explicit control-plane flag; fall back to an explicit
 * `online` boolean; otherwise use `lastSeen` recency. Missing or
 * unparseable timestamps count as disconnected, never silently online.
 */
export function getTailscaleDeviceStatus(device: {
  connectedToControl?: boolean;
  online?: boolean;
  lastSeen?: string | null;
}): DevicePresence {
  if (device.connectedToControl === true) return "connected";
  // Shapes with an explicit online flag but no timestamp
  // (e.g. `tailscale status --json` peers): trust the flag.
  if (device.online === true && !device.lastSeen) return "connected";
  if (device.online === false) return "disconnected";
  return statusFromLastSeen(device.lastSeen);
}

export interface TailscaleApiResponse {
  devices: TailscaleDevice[];
}

export class TailscaleClient {
  private apiKey: string;
  private tailnet: string;
  private baseUrl = "https://api.tailscale.com/api/v2";

  constructor(apiKey: string, tailnet: string) {
    this.apiKey = apiKey;
    this.tailnet = tailnet;
  }

  private async makeRequest<T>(
    endpoint: string,
    options: RequestInit = {},
  ): Promise<T> {
    const url = `${this.baseUrl}${endpoint}`;

    // Timeout guard — Tailscale API should respond quickly; don't hang event loop
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);

    let response: globalThis.Response;
    try {
      response = await fetch(url, {
        ...options,
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json",
          ...options.headers,
        },
      });
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw new Error("Tailscale API request timed out");
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }

    if (!response.ok) {
      // Get detailed error information
      let errorDetails = '';
      try {
        const errorBody = await response.text();
        errorDetails = errorBody;
        console.error(`Error Response Body: ${errorBody}`);
      } catch (e) {
        console.error('Could not read error response body');
      }
      
      throw new Error(
        `Tailscale API error: ${response.status} ${response.statusText}${errorDetails ? ` - ${errorDetails}` : ''}`,
      );
    }

    return response.json();
  }

  async getDevices(): Promise<TailscaleDevice[]> {
    try {
      const response = await this.makeRequest<TailscaleApiResponse>(
        `/tailnet/${encodeURIComponent(this.tailnet)}/devices`,
      );
      return response.devices;
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      // Try alternative endpoint formats
      if (message.includes('403')) {
        // Try without .ts.net suffix
        const simpleTailnet = this.tailnet.replace('.ts.net', '');

        try {
          const response = await this.makeRequest<TailscaleApiResponse>(
            `/tailnet/${encodeURIComponent(simpleTailnet)}/devices`,
          );
          return response.devices;
        } catch {
          // Fall through to original error
        }
      }

      throw error;
    }
  }

  async getDevice(deviceId: string): Promise<TailscaleDevice> {
    return this.makeRequest<TailscaleDevice>(`/device/${deviceId}`);
  }

  async updateDevice(
    deviceId: string,
    updates: Partial<TailscaleDevice>,
  ): Promise<TailscaleDevice> {
    return this.makeRequest<TailscaleDevice>(`/device/${deviceId}`, {
      method: "PATCH",
      body: JSON.stringify(updates),
    });
  }

  async authorizeDevice(deviceId: string): Promise<void> {
    await this.makeRequest(`/device/${deviceId}/authorized`, {
      method: "POST",
      body: JSON.stringify({ authorized: true }),
    });
  }

  async deauthorizeDevice(deviceId: string): Promise<void> {
    await this.makeRequest(`/device/${deviceId}/authorized`, {
      method: "POST",
      body: JSON.stringify({ authorized: false }),
    });
  }

  async deleteDevice(deviceId: string): Promise<void> {
    await this.makeRequest(`/device/${deviceId}`, {
      method: "DELETE",
    });
  }

  // Convert Tailscale device to our internal format
  convertToInternalDevice(tailscaleDevice: TailscaleDevice): InsertDevice {
    const deviceType = this.getDeviceType(tailscaleDevice.os);
    const status = getTailscaleDeviceStatus(tailscaleDevice);

    return {
      name: tailscaleDevice.name,
      hostname: tailscaleDevice.hostname,
      tailscaleId: tailscaleDevice.id,
      ipAddress: tailscaleDevice.addresses?.[0] ?? "Unknown",
      deviceType,
      os: tailscaleDevice.os,
      status,
      tags: tailscaleDevice.tags ?? [],
      isCoordinator: false, // No coordinator designation needed with full access
    };
  }

  private getDeviceType(os: string): string {
    const osLower = os.toLowerCase();
    if (osLower.includes("ios") || osLower.includes("android")) {
      return "mobile";
    }
    if (
      osLower.includes("linux") ||
      osLower.includes("ubuntu") ||
      osLower.includes("debian")
    ) {
      return "server";
    }
    return "desktop";
  }

  // Generate network statistics from devices
  generateNetworkStats(devices: TailscaleDevice[]): NetworkStats {
    const totalDevices = devices.length;
    let onlineDevices = 0;
    let unstableDevices = 0;
    for (const device of devices) {
      const status = getTailscaleDeviceStatus(device);
      if (status === "connected") onlineDevices++;
      else if (status === "unstable") unstableDevices++;
    }
    const offlineDevices = totalDevices - onlineDevices - unstableDevices;

    return {
      id: 1,
      totalDevices,
      onlineDevices,
      offlineDevices,
      unstableDevices,
      lastUpdated: new Date(),
    };
  }
}

// Create singleton instance
let tailscaleClient: TailscaleClient | null = null;

export function getTailscaleClient(): TailscaleClient | null {
  if (!tailscaleClient) {
    const effective = getEffectiveTailscaleConfig();

    if (!effective) {
      return null;
    }

    tailscaleClient = new TailscaleClient(
      effective.apiKey,
      effective.tailnet,
    );
  }

  return tailscaleClient;
}

/** Drop the cached client so the next call picks up new credentials. */
export function resetTailscaleClient(): void {
  tailscaleClient = null;
}

export function isTailscaleConfigured(): boolean {
  return getEffectiveTailscaleConfig() !== null;
}

export { getTailscaleConfigStatus };