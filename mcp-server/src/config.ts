/**
 * Runtime configuration, all environment-driven.
 *
 * The bridge port intentionally defaults to 17374, NOT 17373. WebBrain Cloud's
 * sidecar owns 17373, and `cloud-bridge.js` holds exactly one outbound socket —
 * so the extension can be pointed at Cloud or at this server, never both. Using
 * a distinct port keeps the failure mode obvious ("nothing connected") instead
 * of two processes fighting over one listener.
 */

function parseIntFromEnv(name: string, raw: string): number {
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || String(parsed) !== raw.trim()) {
    throw new Error(`${name} must be an integer, got: ${raw}`);
  }
  return parsed;
}

/** Ports carry a 16-bit ceiling. Durations must NOT — see durationFromEnv. */
function portFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = parseIntFromEnv(name, raw);
  if (parsed <= 0 || parsed > 65535) {
    throw new Error(`${name} must be a valid TCP port (1-65535), got: ${raw}`);
  }
  return parsed;
}

/**
 * Millisecond durations. Deliberately separate from portFromEnv: reusing the
 * port validator here rejected every timeout above 65535ms, including the
 * five-minute default this file itself documents.
 */
function durationFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = parseIntFromEnv(name, raw);
  if (parsed <= 0) {
    throw new Error(`${name} must be a positive duration in milliseconds, got: ${raw}`);
  }
  return parsed;
}

export const config = {
  /** Port this process listens on for the extension's outbound bridge socket. */
  bridgePort: portFromEnv("WEBBRAIN_BRIDGE_PORT", 17374),

  /** Path segment the extension connects to. Must match the URL set in WebBrain settings. */
  bridgePath: process.env.WEBBRAIN_BRIDGE_PATH || "/extension",

  /**
   * How long to wait for the extension to answer a single bridge command.
   * Starting a run returns immediately; this is not the task timeout.
   */
  commandTimeoutMs: durationFromEnv("WEBBRAIN_COMMAND_TIMEOUT_MS", 30_000),

  /** Default ceiling for how long `webbrain_run` will poll before giving up. */
  defaultRunTimeoutMs: durationFromEnv("WEBBRAIN_RUN_TIMEOUT_MS", 300_000),

  /** Interval between `cloud_status` polls while a run is in flight. */
  pollIntervalMs: durationFromEnv("WEBBRAIN_POLL_INTERVAL_MS", 1_000),
} as const;

/** The URL the user must paste into Settings → Bridge. */
export function bridgeUrl(): string {
  return `ws://127.0.0.1:${config.bridgePort}${config.bridgePath}`;
}
