import type {
  Device,
  InsertDevice,
  Connection,
  InsertConnection,
  NetworkStats,
  NetworkTopology,
} from "@shared/schema";
import { getTailscaleClient, isTailscaleConfigured } from "./tailscale";

export interface IStorage {
  // Device operations
  getDevices(): Promise<Device[]>;
  getDevice(id: number): Promise<Device | undefined>;
  getDeviceByTailscaleId(tailscaleId: string): Promise<Device | undefined>;
  createDevice(device: InsertDevice): Promise<Device>;
  updateDevice(id: number, updates: Partial<Device>): Promise<Device>;
  deleteDevice(id: number): Promise<void>;

  // Connection operations
  getConnections(): Promise<Connection[]>;
  createConnection(connection: InsertConnection): Promise<Connection>;
  updateConnection(
    id: number,
    updates: Partial<Connection>,
  ): Promise<Connection>;
  deleteConnection(id: number): Promise<void>;

  // Network stats
  getNetworkStats(): Promise<NetworkStats>;
  updateNetworkStats(stats: Partial<NetworkStats>): Promise<NetworkStats>;

  // Combined operations
  getNetworkTopology(): Promise<NetworkTopology>;
}

export class MemStorage implements IStorage {
  private devices: Map<number, Device> = new Map();
  private connections: Map<number, Connection> = new Map();
  private networkStats: NetworkStats;
  private currentDeviceId = 1;
  private currentConnectionId = 1;

  constructor() {
    this.networkStats = {
      id: 1,
      totalDevices: 0,
      onlineDevices: 0,
      offlineDevices: 0,
      unstableDevices: 0,
      lastUpdated: new Date(),
    };

    // Initialize with sample network topology.
    // Constructor can't be async, so track readiness via `ready` instead of
    // a floating promise (prevents race: requests before init see empty state).
    this.ready = this.initializeSampleData().catch((error) => {
      console.error("Failed to initialize storage:", error);
    });
  }

  /** Resolves when initial data load completes. Await before serving traffic in tests. */
  readonly ready: Promise<void>;

  private async initializeSampleData() {
    // Try to load from Tailscale API first
    if (isTailscaleConfigured()) {
      try {
        await this.syncWithTailscale();
        console.log("Successfully synchronized with Tailscale API");
        return;
      } catch (error: any) {
        if (error.message?.includes('403')) {
          console.error("\n🔐 TAILSCALE API ERROR: 403 Forbidden");
          console.error("Your API key lacks required permissions.");
          console.error("\n✅ SOLUTION:");
          console.error("1. Visit: https://login.tailscale.com/admin/settings/keys");
          console.error("2. Delete your current API key");
          console.error("3. Create new API key with these scopes:");
          console.error("   - devices:read");
          console.error("   - devices:write"); 
          console.error("   - network:read");
          console.error("4. Update your TAILSCALE_API_KEY environment variable");
          console.error("5. Restart the application\n");
        } else if (error.message?.includes('401')) {
          console.error("\n🔑 TAILSCALE API ERROR: 401 Unauthorized");
          console.error("Invalid API key or tailnet name.");
          console.error("\n✅ SOLUTION:");
          console.error("1. Check TAILSCALE_API_KEY is correct");
          console.error("2. Check TAILSCALE_TAILNET matches your organization name");
          console.error("3. Verify API key is not expired\n");
        } else {
          console.error("Failed to sync with Tailscale API:", error);
        }
        console.log("Falling back to sample data for development");
      }
    } else {
      console.log(
        "Tailscale API not configured. Using sample data for development.",
      );
    }

    // Fallback to sample data if Tailscale API is not available
    await this.loadSampleData();
  }

  private async syncWithTailscale(): Promise<void> {
    const client = getTailscaleClient();
    if (!client) {
      throw new Error("Tailscale client not available");
    }

    const tailscaleDevices = await client.getDevices();
    const stats = client.generateNetworkStats(tailscaleDevices);

    // Clear existing data
    this.devices.clear();
    this.connections.clear();
    this.currentDeviceId = 1;
    this.currentConnectionId = 1;

    // Convert and store all devices
    const devices: Device[] = [];
    for (const tailscaleDevice of tailscaleDevices) {
      const deviceData = client.convertToInternalDevice(tailscaleDevice);
      const device = await this.createDevice(deviceData);
      devices.push(device);
    }

    // Create mesh-style connections between all devices
    for (let i = 0; i < devices.length; i++) {
      for (let j = i + 1; j < devices.length; j++) {
        const device1 = devices[i];
        const device2 = devices[j];
        
        // Only create connections for online devices
        if (device1.status === "connected" && device2.status === "connected") {
          await this.createConnection({
            fromDeviceId: device1.id,
            toDeviceId: device2.id,
            status: "active",
          });
        }
      }
    }

    // Update network stats
    this.networkStats = stats;
  }

  private async loadSampleData(): Promise<void> {
    // Create coordinator device
    const coordinator = await this.createDevice({
      name: "coordinator",
      hostname: "coordinator.ts.net",
      tailscaleId: "coord-01",
      ipAddress: "100.64.0.1",
      deviceType: "server",
      os: "Linux",
      status: "connected",
      tags: ["coordinator", "critical"],
      isCoordinator: true,
    });

    // Create sample devices
    const devices = [
      {
        name: "john-macbook",
        hostname: "john-macbook.ts.net",
        tailscaleId: "desktop-01",
        ipAddress: "100.64.0.10",
        deviceType: "desktop",
        os: "macOS",
        status: "connected",
        tags: ["production", "developer"],
        isCoordinator: false,
      },
      {
        name: "jane-laptop",
        hostname: "jane-laptop.ts.net",
        tailscaleId: "desktop-02",
        ipAddress: "100.64.0.11",
        deviceType: "desktop",
        os: "Windows",
        status: "connected",
        tags: ["production"],
        isCoordinator: false,
      },
      {
        name: "john-iphone",
        hostname: "john-iphone.ts.net",
        tailscaleId: "mobile-01",
        ipAddress: "100.64.0.20",
        deviceType: "mobile",
        os: "iOS",
        status: "connected",
        tags: ["mobile"],
        isCoordinator: false,
      },
      {
        name: "jane-iphone",
        hostname: "jane-iphone.ts.net",
        tailscaleId: "mobile-02",
        ipAddress: "100.64.0.21",
        deviceType: "mobile",
        os: "iOS",
        status: "unstable",
        tags: ["mobile"],
        isCoordinator: false,
      },
      {
        name: "prod-server",
        hostname: "prod-server.ts.net",
        tailscaleId: "server-01",
        ipAddress: "100.64.0.100",
        deviceType: "server",
        os: "Linux",
        status: "connected",
        tags: ["production", "server"],
        isCoordinator: false,
      },
      {
        name: "backup-server",
        hostname: "backup-server.ts.net",
        tailscaleId: "server-02",
        ipAddress: "100.64.0.101",
        deviceType: "server",
        os: "Linux",
        status: "disconnected",
        tags: ["backup", "server"],
        isCoordinator: false,
      },
    ];

    const createdDevices = [];
    for (const device of devices) {
      createdDevices.push(await this.createDevice(device));
    }

    // Create connections (all devices connect to coordinator)
    for (const device of createdDevices) {
      await this.createConnection({
        fromDeviceId: coordinator.id,
        toDeviceId: device.id,
        status: device.status === "connected" ? "active" : "inactive",
      });
    }

    // Create some peer-to-peer connections
    if (createdDevices.length >= 2) {
      await this.createConnection({
        fromDeviceId: createdDevices[0].id,
        toDeviceId: createdDevices[1].id,
        status: "active",
      });

      await this.createConnection({
        fromDeviceId: createdDevices[2].id,
        toDeviceId: createdDevices[4].id,
        status: "active",
      });
    }

    await this.updateNetworkStats({});
  }

  async getDevices(): Promise<Device[]> {
    return Array.from(this.devices.values());
  }

  async getDevice(id: number): Promise<Device | undefined> {
    return this.devices.get(id);
  }

  async getDeviceByTailscaleId(
    tailscaleId: string,
  ): Promise<Device | undefined> {
    return Array.from(this.devices.values()).find(
      (d) => d.tailscaleId === tailscaleId,
    );
  }

  async createDevice(insertDevice: InsertDevice): Promise<Device> {
    const id = this.currentDeviceId++;
    const device: Device = {
      id,
      name: insertDevice.name,
      hostname: insertDevice.hostname,
      tailscaleId: insertDevice.tailscaleId,
      ipAddress: insertDevice.ipAddress,
      deviceType: insertDevice.deviceType,
      os: insertDevice.os,
      status: insertDevice.status,
      lastSeen: new Date(),
      tags: insertDevice.tags || [],
      isCoordinator: insertDevice.isCoordinator || false,
      x: Math.random() * 800 + 100,
      y: Math.random() * 600 + 100,
    };
    this.devices.set(id, device);
    return device;
  }

  async updateDevice(id: number, updates: Partial<Device>): Promise<Device> {
    const device = this.devices.get(id);
    if (!device) throw new Error(`Device with id ${id} not found`);

    const updatedDevice = { ...device, ...updates, lastSeen: new Date() };
    this.devices.set(id, updatedDevice);
    return updatedDevice;
  }

  async deleteDevice(id: number): Promise<void> {
    this.devices.delete(id);
    // Also delete related connections
    const connectionsToDelete: number[] = [];
    for (const [connId, conn] of this.connections) {
      if (conn.fromDeviceId === id || conn.toDeviceId === id) {
        connectionsToDelete.push(connId);
      }
    }
    for (const connId of connectionsToDelete) {
      this.connections.delete(connId);
    }
  }

  async getConnections(): Promise<Connection[]> {
    return Array.from(this.connections.values());
  }

  async createConnection(
    insertConnection: InsertConnection,
  ): Promise<Connection> {
    const id = this.currentConnectionId++;
    const connection: Connection = {
      ...insertConnection,
      id,
      lastUpdated: new Date(),
    };
    this.connections.set(id, connection);
    return connection;
  }

  async updateConnection(
    id: number,
    updates: Partial<Connection>,
  ): Promise<Connection> {
    const connection = this.connections.get(id);
    if (!connection) throw new Error(`Connection with id ${id} not found`);

    const updatedConnection = {
      ...connection,
      ...updates,
      lastUpdated: new Date(),
    };
    this.connections.set(id, updatedConnection);
    return updatedConnection;
  }

  async deleteConnection(id: number): Promise<void> {
    this.connections.delete(id);
  }

  async getNetworkStats(): Promise<NetworkStats> {
    return this.networkStats;
  }

  async updateNetworkStats(
    updates: Partial<NetworkStats>,
  ): Promise<NetworkStats> {
    const devices = await this.getDevices();
    const totalDevices = devices.length;
    const onlineDevices = devices.filter(
      (d) => d.status === "connected",
    ).length;
    const offlineDevices = devices.filter(
      (d) => d.status === "disconnected",
    ).length;
    const unstableDevices = devices.filter(
      (d) => d.status === "unstable",
    ).length;

    this.networkStats = {
      ...this.networkStats,
      ...updates,
      totalDevices,
      onlineDevices,
      offlineDevices,
      unstableDevices,
      lastUpdated: new Date(),
    };

    return this.networkStats;
  }

  async getNetworkTopology(): Promise<NetworkTopology> {
    const devices = await this.getDevices();
    const connections = await this.getConnections();
    const stats = await this.getNetworkStats();

    return { devices, connections, stats };
  }

  // Add method to refresh data from Tailscale API
  async refreshFromTailscale(): Promise<void> {
    // Try API first if configured
    if (isTailscaleConfigured()) {
      try {
        await this.syncWithTailscale();
        return;
      } catch (error) {
        console.log("API refresh failed, trying manual import...");
      }
    }

    // Try manual import as fallback
    const { TailscaleManualImporter } = await import("./tailscale-manual");
    const importer = new TailscaleManualImporter();
    const manualDevices = await importer.loadDevicesFromFile();
    
    if (manualDevices.length > 0) {
      console.log(`Refreshing from manual configuration (${manualDevices.length} devices)`);
      
      this.devices.clear();
      this.connections.clear();
      this.currentDeviceId = 1;
      this.currentConnectionId = 1;
      
      for (const device of manualDevices) {
        await this.createDevice(device);
      }
      
      await this.updateNetworkStats({});
      
      // Create connections
      const deviceList = Array.from(this.devices.values());
      if (deviceList.length > 1) {
        const coordinator = deviceList[0];
        for (let i = 1; i < deviceList.length; i++) {
          await this.createConnection({
            fromDeviceId: coordinator.id,
            toDeviceId: deviceList[i].id,
            status: deviceList[i].status === "connected" ? "active" : "inactive",
          });
        }
      }
      
      return;
    }

    throw new Error("No data source available - create tailscale-devices.json or configure API");
  }
}

export const storage = new MemStorage();
