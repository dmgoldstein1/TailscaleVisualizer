import { useEffect, useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { KeyRound, Eye, EyeOff } from "lucide-react";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";

interface TailscaleConfigStatus {
  configured: boolean;
  source: "browser" | "environment" | "none";
  hasApiKey: boolean;
  tailnet: string | null;
  keyLast4: string | null;
}

interface TailscaleSettingsDialogProps {
  isOpen: boolean;
  onClose: () => void;
}

export function TailscaleSettingsDialog({
  isOpen,
  onClose,
}: TailscaleSettingsDialogProps) {
  const { toast } = useToast();
  const [apiKey, setApiKey] = useState("");
  const [tailnet, setTailnet] = useState("");
  const [showSecret, setShowSecret] = useState(false);

  const { data: status, refetch } = useQuery<TailscaleConfigStatus>({
    queryKey: ["/api/config/tailscale"],
  });

  // Prefill the tailnet when the dialog opens; the secret itself is
  // never sent back to the browser, so the key field always starts empty.
  useEffect(() => {
    if (isOpen) {
      setApiKey("");
      setShowSecret(false);
      if (status?.tailnet) {
        setTailnet(status.tailnet);
      }
      void refetch();
    }
  }, [isOpen, status?.tailnet, refetch]);

  const saveMutation = useMutation({
    mutationFn: () =>
      apiRequest("PUT", "/api/config/tailscale", { apiKey, tailnet }),
    onSuccess: async () => {
      toast({
        title: "Credentials saved",
        description: "Tailscale API key verified and network refreshed.",
      });
      setApiKey("");
      await queryClient.invalidateQueries({
        queryKey: ["/api/network/topology"],
      });
      await queryClient.invalidateQueries({
        queryKey: ["/api/config/tailscale"],
      });
      onClose();
    },
    onError: (error: Error) => {
      toast({
        title: "Could not save credentials",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  const clearMutation = useMutation({
    mutationFn: () => apiRequest("DELETE", "/api/config/tailscale"),
    onSuccess: async () => {
      toast({
        title: "Credentials cleared",
        description: "Reverted to environment variables (or demo mode).",
      });
      setApiKey("");
      await queryClient.invalidateQueries({
        queryKey: ["/api/network/topology"],
      });
      await queryClient.invalidateQueries({
        queryKey: ["/api/config/tailscale"],
      });
      onClose();
    },
    onError: (error: Error) => {
      toast({
        title: "Could not clear credentials",
        description: error.message,
        variant: "destructive",
      });
    },
  });

  const canSave =
    apiKey.trim().length >= 10 &&
    tailnet.trim().length > 0 &&
    !saveMutation.isPending;

  return (
    <Dialog open={isOpen} onOpenChange={onClose}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <KeyRound className="h-4 w-4" />
            Tailscale connection
          </DialogTitle>
          <DialogDescription>
            Enter your Tailscale API credentials. They are kept in server
            memory only and never stored on disk.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="flex items-center gap-2 text-sm">
            <span className="text-muted-foreground">Status:</span>
            {status?.configured ? (
              <Badge variant="default">
                {status.source === "browser"
                  ? "Configured in browser"
                  : "Configured via environment"}
                {status.keyLast4 ? ` ••••${status.keyLast4}` : ""}
              </Badge>
            ) : (
              <Badge variant="secondary">Demo mode (not configured)</Badge>
            )}
          </div>

          <div className="space-y-2">
            <Label htmlFor="tailscale-api-key">API key</Label>
            <Input
              id="tailscale-api-key"
              type={showSecret ? "text" : "password"}
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder="tskey-api-…"
              autoComplete="off"
              spellCheck={false}
            />
            <div className="flex items-center space-x-2">
              <Checkbox
                id="show-tailscale-secret"
                checked={showSecret}
                onCheckedChange={(checked) => setShowSecret(checked === true)}
              />
              <label htmlFor="show-tailscale-secret" className="text-sm">
                Make secret visible
              </label>
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="tailscale-tailnet">Tailnet name</Label>
            <Input
              id="tailscale-tailnet"
              type="text"
              value={tailnet}
              onChange={(e) => setTailnet(e.target.value)}
              placeholder="your-tailnet"
              autoComplete="off"
              spellCheck={false}
            />
            <p className="text-xs text-muted-foreground">
              Found in the admin console URL or your device hostnames
              (device.your-tailnet.ts.net).
            </p>
          </div>

          <div className="flex items-center gap-2 pt-2">
            <Button
              className="flex-1"
              disabled={!canSave}
              onClick={() => saveMutation.mutate()}
            >
              {showSecret ? (
                <Eye className="h-4 w-4 mr-2" />
              ) : (
                <EyeOff className="h-4 w-4 mr-2" />
              )}
              {saveMutation.isPending ? "Verifying…" : "Save & connect"}
            </Button>
            {status?.source === "browser" && (
              <Button
                variant="outline"
                disabled={clearMutation.isPending}
                onClick={() => clearMutation.mutate()}
              >
                Forget
              </Button>
            )}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
