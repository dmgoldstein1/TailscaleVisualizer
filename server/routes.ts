import type { Express, Request, Response } from "express";
import { createServer, type Server } from "http";
import { WebSocketServer, WebSocket } from "ws";
import { storage } from "./storage";
import {
  insertDeviceSchema,
  type DeviceUpdate,
} from "@shared/schema";
import { z } from "zod";
import {
  getTailscaleClient,
  getTailscaleConfigStatus,
  getTailscaleDeviceStatus,
  resetTailscaleClient,
  TailscaleClient,
} from "./tailscale";
import { importFromTailscaleExport } from "./tailscale-manual";
import {
  clearBrowserTailscaleConfig,
  setBrowserTailscaleConfig,
} from "./runtime-config";

const idParamSchema = z.object({
  id: z.coerce.number().int().positive(),
});

// Credentials entered via the browser GUI (validated, never echoed back).
const tailscaleCredentialsSchema = z.object({
  apiKey: z.string().trim().min(10).max(200),
  tailnet: z.string().trim().min(1).max(255),
});

// Only allow updating mutable device fields via PATCH.
// insertDeviceSchema omits id/lastSeen/x/y already; .partial() makes all optional.
const updateDeviceSchema = insertDeviceSchema.partial();

function parseId(req: Request, res: Response): number | null {
  const parsed = idParamSchema.safeParse(req.params);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid device id" });
    return null;
  }
  return parsed.data.id;
}

/** Escape Prometheus label values per exposition format. */
function escapePromLabel(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

export async function registerRoutes(app: Express): Promise<Server> {
  const httpServer = createServer(app);

  // WebSocket server for real-time updates
  const wss = new WebSocketServer({
    server: httpServer,
    path: "/ws",
    maxPayload: 1024 * 1024, // 1MB — mitigates ws memory-exhaustion DoS (GHSA-96hv-2xvq-fx4p)
  });

  // Store connected WebSocket clients
  const clients = new Set<WebSocket>();

  wss.on("connection", (ws) => {
    clients.add(ws);

    // Send initial network topology (handle rejection — no floating promise)
    storage
      .getNetworkTopology()
      .then((topology) => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(
            JSON.stringify({ type: "initial_topology", data: topology }),
          );
        }
      })
      .catch((error) => {
        console.error("Failed to send initial topology:", error);
      });

    ws.on("close", () => {
      clients.delete(ws);
    });

    ws.on("error", (error) => {
      console.error("WebSocket error:", error);
      clients.delete(ws);
    });
  });

  // Broadcast updates to all connected clients
  function broadcastUpdate(update: DeviceUpdate) {
    const message = JSON.stringify(update);
    clients.forEach((ws) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(message);
      }
    });
  }

  // API Routes

  // Get network topology
  app.get("/api/network/topology", async (_req, res) => {
    try {
      const topology = await storage.getNetworkTopology();
      res.json(topology);
    } catch (error) {
      console.error("Failed to fetch topology:", error);
      res.status(500).json({ error: "Failed to fetch network topology" });
    }
  });

  // Get all devices
  app.get("/api/devices", async (_req, res) => {
    try {
      const devices = await storage.getDevices();
      res.json(devices);
    } catch (error) {
      console.error("Failed to fetch devices:", error);
      res.status(500).json({ error: "Failed to fetch devices" });
    }
  });

  // Get specific device
  app.get("/api/devices/:id", async (req, res) => {
    try {
      const id = parseId(req, res);
      if (id === null) return;
      const device = await storage.getDevice(id);
      if (!device) {
        res.status(404).json({ error: "Device not found" });
        return;
      }
      res.json(device);
    } catch (error) {
      console.error("Failed to fetch device:", error);
      res.status(500).json({ error: "Failed to fetch device" });
    }
  });

  // Update device status
  app.patch("/api/devices/:id", async (req, res) => {
    try {
      const id = parseId(req, res);
      if (id === null) return;

      const parsed = updateDeviceSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({
          error: "Invalid device update",
          details: parsed.error.issues,
        });
        return;
      }

      const device = await storage.updateDevice(id, parsed.data);

      // Update network stats
      await storage.updateNetworkStats({});
      const stats = await storage.getNetworkStats();

      // Broadcast updates
      broadcastUpdate({ type: "device_status", data: device });
      broadcastUpdate({ type: "stats_updated", data: stats });

      res.json(device);
    } catch (error) {
      if (error instanceof Error && error.message.includes("not found")) {
        res.status(404).json({ error: "Device not found" });
        return;
      }
      console.error("Failed to update device:", error);
      res.status(500).json({ error: "Failed to update device" });
    }
  });

  // Create new device
  app.post("/api/devices", async (req, res) => {
    try {
      const parsed = insertDeviceSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({
          error: "Invalid device data",
          details: parsed.error.issues,
        });
        return;
      }
      const device = await storage.createDevice(parsed.data);

      // Update network stats
      await storage.updateNetworkStats({});
      const stats = await storage.getNetworkStats();

      // Broadcast updates
      broadcastUpdate({ type: "device_connected", data: device });
      broadcastUpdate({ type: "stats_updated", data: stats });

      res.status(201).json(device);
    } catch (error) {
      if (error instanceof z.ZodError) {
        res.status(400).json({
          error: "Invalid device data",
          details: error.issues,
        });
      } else {
        console.error("Failed to create device:", error);
        res.status(500).json({ error: "Failed to create device" });
      }
    }
  });

  // Delete device
  app.delete("/api/devices/:id", async (req, res) => {
    try {
      const id = parseId(req, res);
      if (id === null) return;
      const device = await storage.getDevice(id);

      if (!device) {
        res.status(404).json({ error: "Device not found" });
        return;
      }

      await storage.deleteDevice(id);

      // Update network stats
      await storage.updateNetworkStats({});
      const stats = await storage.getNetworkStats();

      // Broadcast updates
      broadcastUpdate({ type: "device_disconnected", data: device });
      broadcastUpdate({ type: "stats_updated", data: stats });

      res.status(204).send();
    } catch (error) {
      console.error("Failed to delete device:", error);
      res.status(500).json({ error: "Failed to delete device" });
    }
  });

  // Get network stats
  app.get("/api/network/stats", async (_req, res) => {
    try {
      const stats = await storage.getNetworkStats();
      res.json(stats);
    } catch (error) {
      console.error("Failed to fetch stats:", error);
      res.status(500).json({ error: "Failed to fetch network stats" });
    }
  });

  // Simulate device status changes (for demo purposes)
  app.post("/api/network/simulate", async (_req, res) => {
    try {
      const devices = await storage.getDevices();
      if (devices.length === 0) {
        res.status(404).json({ error: "No devices to simulate" });
        return;
      }
      const randomDevice =
        devices[Math.floor(Math.random() * devices.length)];
      if (!randomDevice) {
        res.status(404).json({ error: "No devices to simulate" });
        return;
      }

      const statuses = ["connected", "disconnected", "unstable"];
      const currentStatus = randomDevice.status;
      const alternatives = statuses.filter((s) => s !== currentStatus);
      const newStatus =
        alternatives[Math.floor(Math.random() * alternatives.length)] ??
        "connected";

      const updatedDevice = await storage.updateDevice(randomDevice.id, {
        status: newStatus,
      });

      // Update network stats
      await storage.updateNetworkStats({});
      const stats = await storage.getNetworkStats();

      // Broadcast updates
      broadcastUpdate({ type: "device_status", data: updatedDevice });
      broadcastUpdate({ type: "stats_updated", data: stats });

      res.json({
        message: `Device ${randomDevice.name} status changed to ${newStatus}`,
      });
    } catch (error) {
      console.error("Failed to simulate device change:", error);
      res.status(500).json({ error: "Failed to simulate device change" });
    }
  });

  // Refresh data from Tailscale API
  app.post("/api/network/refresh", async (_req, res) => {
    try {
      await storage.refreshFromTailscale();

      // Get updated topology
      const topology = await storage.getNetworkTopology();

      // Broadcast updates to all clients
      broadcastUpdate({ type: "initial_topology", data: topology });

      res.json({ message: "Network data refreshed successfully", topology });
    } catch (error) {
      console.error("Failed to refresh from Tailscale:", error);
      res.status(500).json({
        error: "Failed to refresh network data",
        details: error instanceof Error ? error.message : "Unknown error",
      });
    }
  });

  // Debug endpoint to test API key permissions
  app.get("/api/debug/tailscale", async (_req, res) => {
    try {
      const client = getTailscaleClient();

      if (!client) {
        const status = getTailscaleConfigStatus();
        res.json({
          status: "not_configured",
          message: "Tailscale API not configured",
          hasApiKey: status.hasApiKey,
          hasTailnet: status.tailnet !== null,
          tailnet: status.tailnet ?? "not set",
          source: status.source,
        });
        return;
      }

      // Test API call
      const devices = await client.getDevices();
      res.json({
        status: "success",
        message: "API key working correctly",
        deviceCount: devices.length,
        devices: devices.map((d) => ({
          name: d.name,
          os: d.os,
          status: getTailscaleDeviceStatus(d),
          connectedToControl: d.connectedToControl ?? null,
        })),
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "Unknown error";
      res.json({
        status: "error",
        message,
        type: message.includes("403")
          ? "permission_denied"
          : message.includes("401")
            ? "unauthorized"
            : "unknown",
      });
    }
  });

  // Current credential status for the GUI settings dialog.
  // The secret itself is never returned — only its last 4 characters.
  app.get("/api/config/tailscale", (_req, res) => {
    res.json(getTailscaleConfigStatus());
  });

  // Save credentials entered in the browser GUI. The key is verified
  // against the live Tailscale API before it is stored.
  app.put("/api/config/tailscale", async (req, res) => {
    const parsed = tailscaleCredentialsSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({
        error: "Invalid credentials",
        details: parsed.error.issues,
      });
      return;
    }
    const { apiKey, tailnet } = parsed.data;

    try {
      // Verify before storing so a typo can't lock the dashboard
      // into a broken state.
      const probe = new TailscaleClient(apiKey, tailnet);
      const devices = await probe.getDevices();

      setBrowserTailscaleConfig(apiKey, tailnet);
      resetTailscaleClient();
      await storage.refreshFromTailscale();

      const topology = await storage.getNetworkTopology();
      broadcastUpdate({ type: "initial_topology", data: topology });

      res.json({
        message: "Tailscale credentials saved",
        deviceCount: devices.length,
        ...getTailscaleConfigStatus(),
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "Unknown error";
      console.error("Failed to save Tailscale credentials:", message);
      res.status(502).json({
        error: "Could not verify credentials against the Tailscale API",
        details: message,
      });
    }
  });

  // Forget browser-entered credentials and revert to environment/demo mode.
  app.delete("/api/config/tailscale", async (_req, res) => {
    try {
      clearBrowserTailscaleConfig();
      resetTailscaleClient();
      await storage.refreshFromTailscale();

      const topology = await storage.getNetworkTopology();
      broadcastUpdate({ type: "initial_topology", data: topology });

      res.json({
        message: "Browser credentials cleared",
        ...getTailscaleConfigStatus(),
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "Unknown error";
      console.error("Failed to clear Tailscale credentials:", message);
      res.status(500).json({
        error: "Failed to clear credentials",
        details: message,
      });
    }
  });

  // Manual device import endpoint
  app.post("/api/devices/import", async (req, res) => {
    try {
      const devices = await importFromTailscaleExport(
        JSON.stringify(req.body),
      );

      // Clear existing devices (await each delete — no fire-and-forget)
      const existing = await storage.getDevices();
      await Promise.all(existing.map((d) => storage.deleteDevice(d.id)));

      // Import new devices
      for (const device of devices) {
        await storage.createDevice(device);
      }

      const topology = await storage.getNetworkTopology();
      broadcastUpdate({ type: "initial_topology", data: topology });

      res.json({
        message: "Successfully imported devices",
        deviceCount: devices.length,
      });
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "Unknown error";
      res.status(400).json({
        error: "Failed to import devices",
        details: message,
      });
    }
  });

  // Metrics endpoint for Prometheus/Grafana
  app.get("/metrics", async (_req, res) => {
    try {
      const stats = await storage.getNetworkStats();
      const devices = await storage.getDevices();

      // Generate Prometheus metrics format (label values escaped)
      const metrics = [
        `# HELP tailscale_total_devices Total number of devices in the network`,
        `# TYPE tailscale_total_devices gauge`,
        `tailscale_total_devices ${stats.totalDevices}`,
        ``,
        `# HELP tailscale_online_devices Number of online devices`,
        `# TYPE tailscale_online_devices gauge`,
        `tailscale_online_devices ${stats.onlineDevices}`,
        ``,
        `# HELP tailscale_offline_devices Number of offline devices`,
        `# TYPE tailscale_offline_devices gauge`,
        `tailscale_offline_devices ${stats.offlineDevices}`,
        ``,
        `# HELP tailscale_unstable_devices Number of unstable devices`,
        `# TYPE tailscale_unstable_devices gauge`,
        `tailscale_unstable_devices ${stats.unstableDevices}`,
        ``,
        `# HELP tailscale_devices_by_status Number of devices by status`,
        `# TYPE tailscale_devices_by_status gauge`,
        `tailscale_devices_by_status{status="connected"} ${stats.onlineDevices}`,
        `tailscale_devices_by_status{status="disconnected"} ${stats.offlineDevices}`,
        `tailscale_devices_by_status{status="unstable"} ${stats.unstableDevices}`,
        ``,
        `# HELP tailscale_device_info Device information`,
        `# TYPE tailscale_device_info gauge`,
        ...devices.map(
          (device) =>
            `tailscale_device_info{name="${escapePromLabel(device.name)}",hostname="${escapePromLabel(device.hostname)}",type="${escapePromLabel(device.deviceType)}",os="${escapePromLabel(device.os)}",status="${escapePromLabel(device.status)}"} 1`,
        ),
      ];

      res.set("Content-Type", "text/plain");
      res.send(metrics.join("\n"));
    } catch (error) {
      console.error("Error generating metrics:", error);
      res.status(500).json({ error: "Failed to generate metrics" });
    }
  });

  // Periodic simulation of network changes (demo mode only — skipped with real data).
  // Stored so it doesn't keep the process alive in tests; cleared on server close.
  // setInterval takes a void callback: run the async body explicitly voided.
  const simulationTimer = setInterval(() => {
    void (async () => {
      try {
        const devices = await storage.getDevices();
        if (devices.length === 0) return;

        // Only simulate if we're not using real Tailscale data
        if (process.env.TAILSCALE_API_KEY && process.env.TAILSCALE_TAILNET) {
          return; // Skip simulation when using real data
        }

        // Randomly change device status
        if (Math.random() < 0.3) {
          // 30% chance
          const randomDevice =
            devices[Math.floor(Math.random() * devices.length)];
          if (!randomDevice) return;

          const statuses = ["connected", "disconnected", "unstable"];
          const currentStatus = randomDevice.status;
          const alternatives = statuses.filter((s) => s !== currentStatus);
          const newStatus =
            alternatives[Math.floor(Math.random() * alternatives.length)] ??
            "connected";

          const updatedDevice = await storage.updateDevice(randomDevice.id, {
            status: newStatus,
          });

          // Update network stats
          await storage.updateNetworkStats({});
          const stats = await storage.getNetworkStats();

          // Broadcast updates
          broadcastUpdate({ type: "device_status", data: updatedDevice });
          broadcastUpdate({ type: "stats_updated", data: stats });
        }
      } catch (error) {
        console.error("Error in periodic simulation:", error);
      }
    })();
  }, 10000); // Every 10 seconds
  // Don't hold the event loop open for this background timer.
  if (typeof simulationTimer.unref === "function") {
    simulationTimer.unref();
  }
  httpServer.on("close", () => {
    clearInterval(simulationTimer);
  });

  return httpServer;
}
