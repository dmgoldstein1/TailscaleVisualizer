import { useState, useEffect } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Search, Bell, Sun, Moon, Network, Zap, RefreshCw, Settings } from "lucide-react";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { NetworkTopology } from "@/components/NetworkTopology";
import { Sidebar } from "@/components/Sidebar";
import { DeviceModal } from "@/components/DeviceModal";
import { TailscaleSettingsDialog } from "@/components/TailscaleSettingsDialog";
import { useWebSocket } from "@/hooks/useWebSocket";
import { useTheme } from "@/components/ThemeProvider";
import type {
  Device,
  NetworkTopology as NetworkTopologyType,
} from "@shared/schema";

export default function Dashboard() {
  const { theme, toggleTheme } = useTheme();
  const [selectedDevice, setSelectedDevice] = useState<Device | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [notificationCount] = useState(3);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const { toast } = useToast();

  const { data: topology, refetch } = useQuery<NetworkTopologyType>({
    queryKey: ["/api/network/topology"],
  });

  const refreshMutation = useMutation({
    mutationFn: () => apiRequest("POST", "/api/network/refresh"),
    onSuccess: () => {
      toast({
        title: "Network Refreshed",
        description: "Successfully updated network data from Tailscale API",
      });
      void queryClient.invalidateQueries({ queryKey: ["/api/network/topology"] });
    },
    onError: (error: Error) => {
      toast({
        title: "Refresh Failed",
        description: error.message || "Failed to refresh network data",
        variant: "destructive",
      });
    },
  });

  const { isConnected, lastMessage } = useWebSocket();

  // Handle real-time updates
  useEffect(() => {
    if (!lastMessage) return;
    try {
      const message = JSON.parse(lastMessage) as { type?: string };

      if (
        message.type === "device_status" ||
        message.type === "stats_updated" ||
        message.type === "initial_topology"
      ) {
        void refetch();
      }
    } catch {
      // Ignore malformed WebSocket payloads
    }
  }, [lastMessage, refetch]);

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
                {topology.devices.find((d) => d.isCoordinator)?.hostname ||
                  "demo-tailnet.ts.net"}
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

            <Button variant="outline" size="icon" className="relative">
              <Bell className="h-4 w-4" />
              {notificationCount > 0 && (
                <Badge className="absolute -top-2 -right-2 h-5 w-5 rounded-full p-0 flex items-center justify-center text-xs">
                  {notificationCount}
                </Badge>
              )}
            </Button>
          </div>
        </div>
      </header>

      <div className="flex">
        {/* Sidebar */}
        <Sidebar stats={topology.stats} devices={topology.devices} />

        {/* Main Content */}
        <main className="flex-1 flex flex-col">
          {/* Tab Navigation */}
          <div className="border-b bg-card/50 backdrop-blur supports-[backdrop-filter]:bg-card/50">
            <div className="px-6 py-4">
              <Tabs defaultValue="topology" className="w-full">
                <TabsList className="grid w-full grid-cols-3">
                  <TabsTrigger
                    value="topology"
                    className="flex items-center space-x-2"
                  >
                    <Network className="h-4 w-4" />
                    <span>Network Topology</span>
                  </TabsTrigger>
                  <TabsTrigger
                    value="grid"
                    className="flex items-center space-x-2"
                  >
                    <div className="grid grid-cols-2 gap-0.5 h-4 w-4">
                      <div className="bg-current rounded-sm" />
                      <div className="bg-current rounded-sm" />
                      <div className="bg-current rounded-sm" />
                      <div className="bg-current rounded-sm" />
                    </div>
                    <span>Device Grid</span>
                  </TabsTrigger>
                  <TabsTrigger
                    value="analytics"
                    className="flex items-center space-x-2"
                  >
                    <Zap className="h-4 w-4" />
                    <span>Analytics</span>
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

                <TabsContent value="grid" className="mt-6">
                  <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4 p-6">
                    {filteredDevices.map((device) => (
                      <Card
                        key={device.id}
                        className="cursor-pointer hover:shadow-lg transition-shadow"
                        onClick={() => setSelectedDevice(device)}
                      >
                        <CardHeader className="pb-3">
                          <div className="flex items-center justify-between">
                            <CardTitle className="text-base">
                              {device.name}
                            </CardTitle>
                            <Badge
                              variant={
                                device.status === "connected"
                                  ? "default"
                                  : device.status === "unstable"
                                    ? "destructive"
                                    : "secondary"
                              }
                            >
                              {device.status}
                            </Badge>
                          </div>
                        </CardHeader>
                        <CardContent>
                          <div className="space-y-2 text-sm">
                            <div className="flex justify-between">
                              <span className="text-muted-foreground">
                                Type:
                              </span>
                              <span>{device.deviceType}</span>
                            </div>
                            <div className="flex justify-between">
                              <span className="text-muted-foreground">IP:</span>
                              <span className="font-mono">
                                {device.ipAddress}
                              </span>
                            </div>
                            <div className="flex justify-between">
                              <span className="text-muted-foreground">OS:</span>
                              <span>{device.os}</span>
                            </div>
                          </div>
                        </CardContent>
                      </Card>
                    ))}
                  </div>
                </TabsContent>

                <TabsContent value="analytics" className="mt-6">
                  <div className="p-6">
                    <Card>
                      <CardHeader>
                        <CardTitle>Network Analytics</CardTitle>
                      </CardHeader>
                      <CardContent>
                        <p className="text-muted-foreground">
                          Analytics dashboard coming soon. This will show
                          network performance metrics, bandwidth usage, and
                          connection quality over time.
                        </p>
                      </CardContent>
                    </Card>
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
