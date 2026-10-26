import {
  pgTable,
  text,
  serial,
  integer,
  boolean,
  timestamp,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

export const devices = pgTable("devices", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  hostname: text("hostname").notNull(),
  tailscaleId: text("tailscale_id").notNull().unique(),
  ipAddress: text("ip_address").notNull(),
  deviceType: text("device_type").notNull(), // desktop, mobile, server
  os: text("os").notNull(),
  status: text("status").notNull(), // connected, disconnected, unstable
  lastSeen: timestamp("last_seen").notNull(),
  tags: text("tags").array().notNull().default([]),
  isCoordinator: boolean("is_coordinator").notNull().default(false),
  x: integer("x").notNull().default(0),
  y: integer("y").notNull().default(0),
});

export const connections = pgTable("connections", {
  id: serial("id").primaryKey(),
  fromDeviceId: integer("from_device_id").notNull(),
  toDeviceId: integer("to_device_id").notNull(),
  status: text("status").notNull(), // active, inactive
  lastUpdated: timestamp("last_updated").notNull(),
});

export const networkStats = pgTable("network_stats", {
  id: serial("id").primaryKey(),
  totalDevices: integer("total_devices").notNull(),
  onlineDevices: integer("online_devices").notNull(),
  offlineDevices: integer("offline_devices").notNull(),
  unstableDevices: integer("unstable_devices").notNull(),
  lastUpdated: timestamp("last_updated").notNull(),
});

export const insertDeviceSchema = createInsertSchema(devices).omit({
  id: true,
  lastSeen: true,
  x: true,
  y: true,
});

export const insertConnectionSchema = createInsertSchema(connections).omit({
  id: true,
  lastUpdated: true,
});

export type Device = typeof devices.$inferSelect;
export type InsertDevice = z.infer<typeof insertDeviceSchema>;
export type Connection = typeof connections.$inferSelect;
export type InsertConnection = z.infer<typeof insertConnectionSchema>;
export type NetworkStats = typeof networkStats.$inferSelect;

export interface NetworkTopology {
  devices: Device[];
  connections: Connection[];
  stats: NetworkStats;
}

export interface DeviceUpdate {
  type:
    | "device_status"
    | "device_connected"
    | "device_disconnected"
    | "stats_updated"
    | "initial_topology";
  data: Device | NetworkStats | NetworkTopology;
}
