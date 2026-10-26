import { Terminal, Zap, X, Monitor, Smartphone, Server } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import type { Device } from "@shared/schema";
import { formatDistanceToNow } from "date-fns";

interface DeviceModalProps {
  device: Device;
  isOpen: boolean;
  onClose: () => void;
}

export function DeviceModal({ device, isOpen, onClose }: DeviceModalProps) {
  const getDeviceIcon = (deviceType: string) => {
    switch (deviceType) {
      case "desktop":
        return <Monitor className="h-6 w-6" />;
      case "mobile":
        return <Smartphone className="h-6 w-6" />;
      case "server":
        return <Server className="h-6 w-6" />;
      default:
        return <Monitor className="h-6 w-6" />;
    }
  };

  const getStatusColor = (status: string) => {
    switch (status) {
      case "connected":
        return "bg-connected-green";
      case "unstable":
        return "bg-warning-yellow";
      case "disconnected":
        return "bg-muted";
      default:
        return "bg-muted";
    }
  };

  const getStatusVariant = (status: string) => {
    switch (status) {
      case "connected":
        return "default";
      case "unstable":
        return "destructive";
      case "disconnected":
        return "secondary";
      default:
        return "secondary";
    }
  };

  const handleSSHConnect = () => {
    // In a real implementation, this would open an SSH connection
    console.log(`SSH connecting to ${device.ipAddress}`);
  };

  const handlePingTest = () => {
    // In a real implementation, this would run a ping test
    console.log(`Pinging ${device.ipAddress}`);
  };

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center justify-between">
            Device Details
            <Button variant="ghost" size="icon" onClick={onClose}>
              <X className="h-4 w-4" />
            </Button>
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          {/* Device Header */}
          <div className="flex items-center space-x-4">
            <div className="flex h-12 w-12 items-center justify-center rounded-lg bg-muted">
              {getDeviceIcon(device.deviceType)}
            </div>
            <div className="flex-1 min-w-0">
              <h4 className="font-medium truncate">{device.name}</h4>
              <p className="text-sm text-muted-foreground capitalize">
                {device.deviceType}
              </p>
            </div>
          </div>

          {/* Device Information */}
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1">
              <label className="text-sm font-medium text-muted-foreground">
                Status
              </label>
              <div className="flex items-center space-x-2">
                <div
                  className={`w-2 h-2 rounded-full ${getStatusColor(device.status)}`}
                />
                <Badge
                  variant={getStatusVariant(device.status)}
                  className="capitalize"
                >
                  {device.status}
                </Badge>
              </div>
            </div>

            <div className="space-y-1">
              <label className="text-sm font-medium text-muted-foreground">
                IP Address
              </label>
              <p className="text-sm font-mono">{device.ipAddress}</p>
            </div>

            <div className="space-y-1">
              <label className="text-sm font-medium text-muted-foreground">
                Last Seen
              </label>
              <p className="text-sm">
                {formatDistanceToNow(new Date(device.lastSeen), {
                  addSuffix: true,
                })}
              </p>
            </div>

            <div className="space-y-1">
              <label className="text-sm font-medium text-muted-foreground">
                Operating System
              </label>
              <p className="text-sm">{device.os}</p>
            </div>
          </div>

          {/* Hostname */}
          <div className="space-y-1">
            <label className="text-sm font-medium text-muted-foreground">
              Hostname
            </label>
            <p className="text-sm font-mono">{device.hostname}</p>
          </div>

          {/* Tags */}
          {device.tags && device.tags.length > 0 && (
            <div className="space-y-2">
              <label className="text-sm font-medium text-muted-foreground">
                Tags
              </label>
              <div className="flex flex-wrap gap-1">
                {device.tags.map((tag, index) => (
                  <Badge key={index} variant="outline" className="text-xs">
                    {tag}
                  </Badge>
                ))}
              </div>
            </div>
          )}

          {/* Actions */}
          <div className="flex space-x-2 pt-4">
            <Button
              className="flex-1 bg-tailscale-purple hover:bg-tailscale-purple/90"
              onClick={handleSSHConnect}
              disabled={device.status === "disconnected"}
            >
              <Terminal className="h-4 w-4 mr-2" />
              SSH Connect
            </Button>
            <Button
              variant="outline"
              className="flex-1"
              onClick={handlePingTest}
            >
              <Zap className="h-4 w-4 mr-2" />
              Ping Test
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
