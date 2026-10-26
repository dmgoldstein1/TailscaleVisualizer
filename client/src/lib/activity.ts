import type { Device } from "@shared/schema";

export type ActivityType = "connected" | "disconnected" | "unstable";

export interface ActivityEntry {
  id: string;
  message: string;
  /** ISO timestamp the entry refers to. */
  time: string;
  type: ActivityType;
}

let activityCounter = 0;

function statusVerb(status: string): string {
  switch (status) {
    case "connected":
      return "connected";
    case "disconnected":
      return "disconnected";
    default:
      return "unstable connection";
  }
}

function toActivityType(status: string): ActivityType {
  return status === "connected" || status === "disconnected"
    ? status
    : "unstable";
}

/** Seed the feed from current devices, most recently seen first. */
export function seedActivities(
  devices: Device[],
  limit = 6,
): ActivityEntry[] {
  return [...devices]
    .sort(
      (a, b) =>
        new Date(b.lastSeen).getTime() - new Date(a.lastSeen).getTime(),
    )
    .slice(0, limit)
    .map((d) => ({
      id: `seed-${d.id}`,
      message: `${d.name} ${statusVerb(d.status)}`,
      time: new Date(d.lastSeen).toISOString(),
      type: toActivityType(d.status),
    }));
}

interface DeviceUpdateMessage {
  type?: string;
  data?: unknown;
}

function isDeviceLike(
  data: unknown,
): data is { name: string; status: string } {
  return (
    typeof data === "object" &&
    data !== null &&
    "name" in data &&
    typeof (data as { name: unknown }).name === "string" &&
    "status" in data &&
    typeof (data as { status: unknown }).status === "string"
  );
}

/** Turn a WebSocket device update into a feed entry (null = not activity). */
export function activityFromUpdate(
  message: DeviceUpdateMessage,
): ActivityEntry | null {
  const { type, data } = message;
  if (
    type !== "device_status" &&
    type !== "device_connected" &&
    type !== "device_disconnected"
  ) {
    return null;
  }
  if (!isDeviceLike(data)) return null;
  activityCounter += 1;
  return {
    id: `live-${Date.now()}-${activityCounter}`,
    message: `${data.name} ${statusVerb(data.status)}`,
    time: new Date().toISOString(),
    type: toActivityType(data.status),
  };
}
