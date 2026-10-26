// Runtime Tailscale credentials entered via the browser GUI.
//
// These live only in server memory (never written to disk) and take
// precedence over the TAILSCALE_API_KEY / TAILSCALE_TAILNET environment
// variables. Clearing them reverts to the environment (or demo mode).

export type TailscaleConfigSource = "browser" | "environment" | "none";

interface EffectiveTailscaleConfig {
  apiKey: string;
  tailnet: string;
  source: Exclude<TailscaleConfigSource, "none">;
}

let browserApiKey: string | null = null;
let browserTailnet: string | null = null;

export function setBrowserTailscaleConfig(
  apiKey: string,
  tailnet: string,
): void {
  browserApiKey = apiKey;
  browserTailnet = tailnet;
}

export function clearBrowserTailscaleConfig(): void {
  browserApiKey = null;
  browserTailnet = null;
}

export function getEffectiveTailscaleConfig(): EffectiveTailscaleConfig | null {
  if (browserApiKey && browserTailnet) {
    return { apiKey: browserApiKey, tailnet: browserTailnet, source: "browser" };
  }
  const apiKey = process.env.TAILSCALE_API_KEY;
  const tailnet = process.env.TAILSCALE_TAILNET;
  if (apiKey && tailnet) {
    return { apiKey, tailnet, source: "environment" };
  }
  return null;
}

/** Public status for the GUI — never includes the secret itself. */
export function getTailscaleConfigStatus(): {
  configured: boolean;
  source: TailscaleConfigSource;
  hasApiKey: boolean;
  tailnet: string | null;
  keyLast4: string | null;
} {
  const effective = getEffectiveTailscaleConfig();
  if (!effective) {
    return {
      configured: false,
      source: "none",
      hasApiKey: false,
      tailnet: process.env.TAILSCALE_TAILNET ?? null,
      keyLast4: null,
    };
  }
  return {
    configured: true,
    source: effective.source,
    hasApiKey: true,
    tailnet: effective.tailnet,
    keyLast4: effective.apiKey.slice(-4),
  };
}
