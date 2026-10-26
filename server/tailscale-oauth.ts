// Alternative approach using OAuth2 authentication

interface OAuthTokenResponse {
  access_token: string;
  expires_in: number;
}

export class TailscaleOAuthClient {
  private clientId: string;
  private clientSecret: string;
  private accessToken?: string;
  private tokenExpiry?: Date;

  constructor(clientId: string, clientSecret: string) {
    this.clientId = clientId;
    this.clientSecret = clientSecret;
  }

  async getAccessToken(): Promise<string> {
    if (this.accessToken && this.tokenExpiry && this.tokenExpiry > new Date()) {
      return this.accessToken;
    }

    // Get new token
    const response = await fetch(
      "https://api.tailscale.com/api/v2/oauth/token",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          grant_type: "client_credentials",
          client_id: this.clientId,
          client_secret: this.clientSecret,
          scope: "devices:read",
        }),
      },
    );

    if (!response.ok) {
      throw new Error(`OAuth token request failed: ${response.status}`);
    }

    const data = (await response.json()) as Partial<OAuthTokenResponse>;
    if (typeof data.access_token !== "string" || data.access_token.length === 0) {
      throw new Error("OAuth token response missing access_token");
    }
    const expiresIn =
      typeof data.expires_in === "number" && Number.isFinite(data.expires_in)
        ? data.expires_in
        : 3600;
    this.accessToken = data.access_token;
    this.tokenExpiry = new Date(Date.now() + expiresIn * 1000);

    return this.accessToken;
  }
}

// Alternative: Use machine authentication
export async function getMachineAuthToken(): Promise<string | null> {
  try {
    // Try to read the Tailscale auth key from the local machine
    const fs = await import("node:fs");
    const os = await import("node:os");

    // Common locations for Tailscale auth
    const home = os.homedir();
    const paths = [
      `${home}/.config/tailscale/tailscaled.state`,
      "/var/lib/tailscale/tailscaled.state",
      `${process.env.HOME ?? home}/.tailscale/tailscaled.state`,
    ];

    for (const filePath of paths) {
      try {
        const data = await fs.promises.readFile(filePath, "utf-8");
        // Extract auth token from state file
        const match = data.match(/"AuthKey":"([^"]+)"/);
        if (match?.[1]) {
          return match[1];
        }
      } catch {
        // Continue to next path
      }
    }
  } catch {
    // Machine auth not available
  }

  return null;
}

interface TailscaleStatusJson {
  Peer?: Record<string, unknown>;
}

// Alternative: Use Tailscale CLI if available
export async function getTailscaleDevicesFromCLI(): Promise<unknown[]> {
  try {
    const { exec } = await import("node:child_process");
    const { promisify } = await import("node:util");
    const execAsync = promisify(exec);

    const { stdout } = await execAsync("tailscale status --json");
    const data = JSON.parse(stdout) as Partial<TailscaleStatusJson>;

    return Object.values(data.Peer ?? {});
  } catch {
    return [];
  }
}
