import { useState, useEffect, useCallback } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Search, Bell, Sun, Moon, Network, RefreshCw, Settings, ChartColumn, ChevronRight } from "lucide-react";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { NetworkTopology } from "@/components/NetworkTopology";
import { Sidebar } from "@/components/Sidebar";
import { DeviceModal } from "@/components/DeviceModal";
import { DeviceChart } from "@/components/DeviceChart";
import { TailscaleSettingsDialog } from "@/components/TailscaleSettingsDialog";
import type { TailscaleConfigStatus } from "@/components/TailscaleSettingsDialog";
import { useWebSocket } from "@/hooks/useWebSocket";
import { useTheme } from "@/components/ThemeProvider";
import { getTailnetDisplay } from "@/lib/networkUtils";
import { formatDistanceToNow } from "date-fns";
import {
  seedActivities,
  activityFromUpdate,
  type ActivityEntry,
} from "@/lib/activity";
import type {
  Device,
  NetworkTopology as NetworkTopologyType,
} from "@shared/schema";

interface Notification {
  id: string;
  title: string;
  description?: string;
  time: string;
  read: boolean;
  variant: "info" | "success" | "destructive";
}

export default function Dashboard() {
  const { theme, toggleTheme } = useTheme();
  const [selectedDevice, setSelectedDevice] = useState<Device | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [activities, setActivities] = useState<ActivityEntry[]>([]);
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const { toast } = useToast();

  const unreadCount = notifications.filter((n) => !n.read).length;

  const pushNotification = useCallback(
    (n: Omit<Notification, "id" | "time" | "read">) => {
      setNotifications((prev) =>
        [
          {
            ...n,
            id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
            time: new Date().toISOString(),
            read: false,
          },
          ...prev,
        ].slice(0, 20),
      );
    },
    [],
  );

  const markAllNotificationsRead = useCallback(() => {
    setNotifications((prev) => prev.map((n) => ({ ...n, read: true })));
  }, []);

  const clearNotifications = useCallback(() => {
    setNotifications([]);
  }, []);

  const { data: topology, refetch } = useQuery<NetworkTopologyType>({
    queryKey: ["/api/network/topology"],
  });

  const { data: configStatus } = useQuery<TailscaleConfigStatus>({
    queryKey: ["/api/config/tailscale"],
  });

  const refreshMutation = useMutation({
    mutationFn: () => apiRequest("POST", "/api/network/refresh"),
    onSuccess: () => {
      toast({
        title: "Network Refreshed",
        description: "Successfully updated network data from Tailscale API",
      });
      pushNotification({
        title: "Network refreshed",
        description: "Successfully updated network data from Tailscale API",
        variant: "success",
      });
      void queryClient.invalidateQueries({ queryKey: ["/api/network/topology"] });
    },
    onError: (error: Error) => {
      toast({
        title: "Refresh Failed",
        description: error.message || "Failed to refresh network data",
        variant: "destructive",
      });
      pushNotification({
        title: "Refresh failed",
        description: error.message || "Failed to refresh network data",
        variant: "destructive",
      });
    },
  });

  const { isConnected, lastMessage } = useWebSocket();

  // Seed the activity feed from the current snapshot. Re-seed whenever the
  // device set itself changes (e.g. demo data -> real Tailscale sync) so
  // stale entries from a previous dataset never linger; live WebSocket
  // events keep it fresh in between.
  const deviceSignature = topology
    ? topology.devices
        .map((d) => d.id)
        .sort((a, b) => a - b)
        .join(",")
    : "";
  const [seedSignature, setSeedSignature] = useState<string | null>(null);
  useEffect(() => {
    if (topology && seedSignature !== deviceSignature) {
      setSeedSignature(deviceSignature);
      setActivities(seedActivities(topology.devices));
    }
  }, [topology, deviceSignature, seedSignature]);

  // Handle real-time updates
  useEffect(() => {
    if (!lastMessage) return;
    try {
      const message = JSON.parse(lastMessage) as { type?: string; data?: unknown };

      if (
        message.type === "device_status" ||
        message.type === "stats_updated" ||
        message.type === "initial_topology"
      ) {
        void refetch();
      }

      const entry = activityFromUpdate(message);
      if (entry) {
        setActivities((prev) => [entry, ...prev].slice(0, 8));
        pushNotification({
          title: entry.message,
          variant: entry.type === "disconnected" ? "destructive" : "info",
        });
      }
    } catch {
      // Ignore malformed WebSocket payloads
    }
  }, [lastMessage, refetch, pushNotification]);

  const filteredDevices =
    topology?.devices?.filter(
      (device) =>
        device.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
        device.hostname.toLowerCase().includes(searchQuery.toLowerCase()) ||
        device.ipAddress.includes(searchQuery),
    ) || [];

  if (!topology) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="text-center">
          <Network className="h-12 w-12 text-primary mx-auto mb-4" />
          <p className="text-muted-foreground">Loading network topology...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background">
      {/* Header */}
      <header className="border-b bg-card/50 backdrop-blur supports-[backdrop-filter]:bg-card/50">
        <div className="flex h-16 items-center px-6">
          <div className="flex items-center space-x-4">
            <div className="flex items-center space-x-2">
              <Network className="h-6 w-6 text-primary" />
              <h1 className="text-xl font-semibold">Tailscale Network</h1>
            </div>
            <div className="flex items-center space-x-2 text-sm text-muted-foreground">
              <span>
                {getTailnetDisplay(
                  topology.devices,
                  configStatus?.tailnet,
                )}
              </span>
              <div
                className={`w-2 h-2 rounded-full ${isConnected ? "bg-connected-green" : "bg-error-red"}`}
              />
              <span>{isConnected ? "Connected" : "Disconnected"}</span>
            </div>
          </div>

          <div className="flex items-center space-x-4 ml-auto">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder="Search devices..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="pl-9 w-64"
              />
            </div>

            <Button
              variant="outline"
              size="icon"
              onClick={() => refreshMutation.mutate()}
              disabled={refreshMutation.isPending}
              title="Refresh from Tailscale API"
            >
              <RefreshCw
                className={`h-4 w-4 ${refreshMutation.isPending ? "animate-spin" : ""}`}
              />
            </Button>

            <Button
              variant="outline"
              size="icon"
              onClick={() => setSettingsOpen(true)}
              title="Tailscale connection settings"
            >
              <Settings className="h-4 w-4" />
            </Button>

            <Button variant="outline" size="icon" onClick={toggleTheme}>
              {theme === "dark" ? (
                <Sun className="h-4 w-4" />
              ) : (
                <Moon className="h-4 w-4" />
              )}
            </Button>

            <DropdownMenu
              onOpenChange={(open) => {
                if (open) markAllNotificationsRead();
              }}
            >
              <DropdownMenuTrigger asChild>
                <Button
                  variant="outline"
                  size="icon"
                  className="relative"
                  title="Notifications"
                >
                  <Bell className="h-4 w-4" />
                  {unreadCount > 0 && (
                    <Badge className="absolute -top-2 -right-2 h-5 w-5 rounded-full p-0 flex items-center justify-center text-xs">
                      {unreadCount}
                    </Badge>
                  )}
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-80">
                <DropdownMenuLabel className="flex items-center justify-between">
                  <span>Notifications</span>
                  {notifications.length > 0 && (
                    <button
                      type="button"
                      onClick={clearNotifications}
                      className="text-xs font-normal text-muted-foreground hover:text-foreground"
                    >
                      Clear
                    </button>
                  )}
                </DropdownMenuLabel>
                <DropdownMenuSeparator />
                {notifications.length === 0 ? (
                  <p className="px-2 py-4 text-sm text-muted-foreground">
                    No notifications yet. Device changes and refresh results
                    will appear here.
                  </p>
                ) : (
                  <div className="max-h-80 overflow-y-auto">
                    {notifications.map((n) => (
                      <div
                        key={n.id}
                        className="flex items-start gap-2 px-2 py-2"
                      >
                        <span
                          className={`mt-1.5 h-2 w-2 rounded-full shrink-0 ${
                            n.variant === "destructive"
                              ? "bg-error-red"
                              : n.variant === "success"
                                ? "bg-connected-green"
                                : "bg-warning-yellow"
                          }`}
                        />
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-medium leading-tight">
                            {n.title}
                          </p>
                          {n.description && (
                            <p className="text-xs text-muted-foreground truncate">
                              {n.description}
                            </p>
                          )}
                          <p className="text-xs text-muted-foreground">
                            {formatDistanceToNow(new Date(n.time), {
                              addSuffix: true,
                            })}
                          </p>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
      </header>

      <div className="flex">
        {/* Sidebar */}
        <Sidebar
          stats={topology.stats}
          devices={topology.devices}
          activities={activities}
        />

        {/* Main Content */}
        <main className="flex-1 flex flex-col">
          {/* Tab Navigation */}
          <div className="border-b bg-card/50 backdrop-blur supports-[backdrop-filter]:bg-card/50">
            <div className="px-6 py-4">
              <Tabs defaultValue="topology" className="w-full">
                <TabsList className="grid w-full grid-cols-2">
                  <TabsTrigger
                    value="topology"
                    className="flex items-center space-x-2"
                  >
                    <Network className="h-4 w-4" />
                    <span>Network Topology</span>
                  </TabsTrigger>
                  <TabsTrigger
                    value="chart"
                    className="flex items-center space-x-2"
                  >
                    <ChartColumn className="h-4 w-4" />
                    <span>Device Chart</span>
                  </TabsTrigger>
                </TabsList>

                <TabsContent value="topology" className="mt-6">
                  <div className="h-[calc(100vh-12rem)]">
                    <NetworkTopology
                      devices={filteredDevices}
                      connections={topology.connections}
                      onDeviceClick={setSelectedDevice}
                    />
                  </div>
                </TabsContent>

                <TabsContent value="chart" className="mt-6">
                  <div className="p-6 space-y-4">
                    <DeviceChart devices={filteredDevices} />

                    <div className="space-y-2">
                      <h3 className="text-md font-medium">
                        Devices ({filteredDevices.length})
                      </h3>
                      {filteredDevices.length === 0 ? (
                        <p className="text-sm text-muted-foreground">
                          No devices match the current search.
                        </p>
                      ) : (
                        <div className="rounded-lg border divide-y">
                          {filteredDevices.map((device) => (
                            <button
                              key={device.id}
                              type="button"
                              onClick={() => setSelectedDevice(device)}
                              className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-muted/50 transition-colors"
                            >
                              <span
                                className={`h-2.5 w-2.5 rounded-full shrink-0 ${
                                  device.status === "connected"
                                    ? "bg-connected-green"
                                    : device.status === "unstable"
                                      ? "bg-warning-yellow"
                                      : "bg-muted-foreground"
                                }`}
                              />
                              <span className="flex-1 min-w-0">
                                <span className="block text-sm font-medium truncate">
                                  {device.name}
                                </span>
                                <span className="block text-xs text-muted-foreground truncate">
                                  {device.hostname}
                                </span>
                              </span>
                              <span className="hidden md:block text-xs font-mono text-muted-foreground">
                                {device.ipAddress}
                              </span>
                              <span className="hidden sm:block text-xs text-muted-foreground capitalize">
                                {device.deviceType} • {device.os}
                              </span>
                              <Badge
                                variant={
                                  device.status === "connected"
                                    ? "default"
                                    : device.status === "unstable"
                                      ? "destructive"
                                      : "secondary"
                                }
                                className="capitalize"
                              >
                                {device.status}
                              </Badge>
                              <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0" />
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                </TabsContent>
              </Tabs>
            </div>
          </div>
        </main>
      </div>

      {/* Device Details Modal */}
      {selectedDevice ? (
        <DeviceModal
          device={selectedDevice}
          isOpen={true}
          onClose={() => setSelectedDevice(null)}
        />
      ) : null}

      {/* Tailscale connection settings */}
      <TailscaleSettingsDialog
        isOpen={settingsOpen}
        onClose={() => setSettingsOpen(false)}
      />
    </div>
  );
}
