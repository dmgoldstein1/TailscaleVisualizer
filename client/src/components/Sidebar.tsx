import { useState } from "react";
import { Monitor, Smartphone, Server, Activity, Filter } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import type { Device, NetworkStats } from "@shared/schema";

interface SidebarProps {
  stats: NetworkStats;
  devices: Device[];
}

export function Sidebar({ stats, devices }: SidebarProps) {
  const [showOnline, setShowOnline] = useState(true);
  const [showOffline, setShowOffline] = useState(false);
  const [showUnstable, setShowUnstable] = useState(true);

  const deviceTypeCounts = {
    desktop: devices.filter((d) => d.deviceType === "desktop").length,
    mobile: devices.filter((d) => d.deviceType === "mobile").length,
    server: devices.filter((d) => d.deviceType === "server").length,
  };

  // Recent activity simulation
  const recentActivity = [
    {
      id: 1,
      message: "john-macbook connected",
      time: "2 minutes ago",
      type: "connected",
    },
    {
      id: 2,
      message: "server-prod-01 disconnected",
      time: "15 minutes ago",
      type: "disconnected",
    },
    {
      id: 3,
      message: "jane-iphone unstable connection",
      time: "1 hour ago",
      type: "unstable",
    },
  ];

  const getActivityColor = (type: string) => {
    switch (type) {
      case "connected":
        return "bg-connected-green";
      case "disconnected":
        return "bg-error-red";
      case "unstable":
        return "bg-warning-yellow";
      default:
        return "bg-muted";
    }
  };

  return (
    <div className="w-80 bg-card border-r p-6 overflow-y-auto">
      <div className="space-y-6">
        {/* Network Stats */}
        <div className="space-y-4">
          <h2 className="text-lg font-semibold">Network Overview</h2>
          <div className="grid grid-cols-2 gap-4">
            <Card>
              <CardContent className="p-4">
                <div className="flex items-center justify-between">
                  <span className="text-sm text-muted-foreground">
                    Total Devices
                  </span>
                  <Monitor className="h-4 w-4 text-muted-foreground" />
                </div>
                <div className="text-2xl font-bold mt-2">
                  {stats.totalDevices}
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardContent className="p-4">
                <div className="flex items-center justify-between">
                  <span className="text-sm text-muted-foreground">Online</span>
                  <div className="w-2 h-2 bg-connected-green rounded-full" />
                </div>
                <div className="text-2xl font-bold text-connected-green mt-2">
                  {stats.onlineDevices}
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardContent className="p-4">
                <div className="flex items-center justify-between">
                  <span className="text-sm text-muted-foreground">Offline</span>
                  <div className="w-2 h-2 bg-muted rounded-full" />
                </div>
                <div className="text-2xl font-bold text-muted-foreground mt-2">
                  {stats.offlineDevices}
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardContent className="p-4">
                <div className="flex items-center justify-between">
                  <span className="text-sm text-muted-foreground">
                    Unstable
                  </span>
                  <div className="w-2 h-2 bg-warning-yellow rounded-full" />
                </div>
                <div className="text-2xl font-bold text-warning-yellow mt-2">
                  {stats.unstableDevices}
                </div>
              </CardContent>
            </Card>
          </div>
        </div>

        {/* Device Filters */}
        <div className="space-y-4">
          <div className="flex items-center space-x-2">
            <Filter className="h-4 w-4" />
            <h3 className="text-md font-medium">Filter Devices</h3>
          </div>
          <div className="space-y-3">
            <div className="flex items-center space-x-2">
              <Checkbox
                id="show-online"
                checked={showOnline}
                onCheckedChange={(checked) => setShowOnline(checked === true)}
              />
              <label htmlFor="show-online" className="text-sm">
                Show Online
              </label>
            </div>
            <div className="flex items-center space-x-2">
              <Checkbox
                id="show-offline"
                checked={showOffline}
                onCheckedChange={(checked) => setShowOffline(checked === true)}
              />
              <label htmlFor="show-offline" className="text-sm">
                Show Offline
              </label>
            </div>
            <div className="flex items-center space-x-2">
              <Checkbox
                id="show-unstable"
                checked={showUnstable}
                onCheckedChange={(checked) => setShowUnstable(checked === true)}
              />
              <label htmlFor="show-unstable" className="text-sm">
                Show Unstable
              </label>
            </div>
          </div>
        </div>

        {/* Device Types */}
        <div className="space-y-4">
          <h3 className="text-md font-medium">Device Types</h3>
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center space-x-2">
                <Monitor className="h-4 w-4 text-muted-foreground" />
                <span className="text-sm">Desktop</span>
              </div>
              <Badge variant="secondary">{deviceTypeCounts.desktop}</Badge>
            </div>
            <div className="flex items-center justify-between">
              <div className="flex items-center space-x-2">
                <Smartphone className="h-4 w-4 text-muted-foreground" />
                <span className="text-sm">Mobile</span>
              </div>
              <Badge variant="secondary">{deviceTypeCounts.mobile}</Badge>
            </div>
            <div className="flex items-center justify-between">
              <div className="flex items-center space-x-2">
                <Server className="h-4 w-4 text-muted-foreground" />
                <span className="text-sm">Server</span>
              </div>
              <Badge variant="secondary">{deviceTypeCounts.server}</Badge>
            </div>
          </div>
        </div>

        {/* Recent Activity */}
        <div className="space-y-4">
          <div className="flex items-center space-x-2">
            <Activity className="h-4 w-4" />
            <h3 className="text-md font-medium">Recent Activity</h3>
          </div>
          <div className="space-y-3">
            {recentActivity.map((activity) => (
              <div key={activity.id} className="flex items-start space-x-3">
                <div
                  className={`w-2 h-2 rounded-full mt-2 ${getActivityColor(activity.type)}`}
                />
                <div className="flex-1 min-w-0">
                  <p className="text-sm">{activity.message}</p>
                  <p className="text-xs text-muted-foreground">
                    {activity.time}
                  </p>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
