/**
 * CLI login command — browser-based OAuth flow or code-based authentication.
 *
 * Two modes:
 * 1. Browser flow (default): Uses base-cli performLogin for the OAuth callback flow.
 * 2. Code flow (--code): Uses a one-time code generated in the web UI.
 *
 * Pew-specific: host resolution (dev vs prod) and accent color.
 */

import { performLogin } from "@nocoo/base-cli";
import { ConfigManager, DEFAULT_HOST, DEV_HOST, credentialHostScope } from "../config/manager.js";

// ---------------------------------------------------------------------------
// Host constants
// ---------------------------------------------------------------------------

// Defined in config/manager.ts so credential readers (upload engine, logout)
// can share them without importing a command module; re-exported here because
// commands and tests import them from this module.
export { DEFAULT_HOST, DEV_HOST };

/**
 * Resolve the API host, with an explicit override winning over dev/prod.
 *
 * Precedence: explicit `--host` value > PEW_HOST env > DEV_HOST (dev) >
 * DEFAULT_HOST. Used by self-hosted deployments pointing the CLI at an
 * intranet pew instance.
 */
export function resolveHost(dev: boolean, override?: string): string {
  const host = override ?? process.env.PEW_HOST;
  if (host?.trim()) return host.trim().replace(/\/+$/, "");
  return dev ? DEV_HOST : DEFAULT_HOST;
}

/**
 * Parse `--host=<url>` / `--host <url>` from argv, for callers that do not
 * route through the command-arg parser.
 */
export function parseHostArg(argv: string[]): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--host") return argv[i + 1];
    if (arg?.startsWith("--host=")) return arg.slice("--host=".length);
  }
  return undefined;
}

// Pew accent color (green)
const PEW_ACCENT_COLOR = "#22c55e";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface LoginOptions {
  /** Directory for config file */
  configDir: string;
  /** Base URL of the pew SaaS */
  apiUrl: string;
  /** Whether dev mode is active (uses config.dev.json) */
  dev?: boolean;
  /** Timeout in milliseconds (default: 120000) */
  timeoutMs?: number;
  /** Force re-login even if already authenticated */
  force?: boolean;
  /** Injected browser opener (for testing) */
  openBrowser: (url: string) => Promise<void>;
  /** Injected nonce generator (for testing determinism) */
  generateNonce?: () => string;
  /** One-time auth code from web UI (skips browser flow) */
  code?: string;
  /**
   * When set, credentials are stored in a per-host config file
   * (config.<host>.json) instead of the shared config.json. Callers set this
   * only when the host came from an explicit --host / PEW_HOST override, so a
   * self-hosted login cannot clobber SaaS credentials.
   */
  hostIsolation?: string;
  /** Injected fetch function (for testing) */
  fetch?: typeof globalThis.fetch;
  /** Log function for browser flow messages (default: console.log) */
  log?: (msg: string) => void;
}

export interface LoginResult {
  success: boolean;
  email?: string;
  alreadyLoggedIn?: boolean;
  error?: string;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export async function executeLogin(options: LoginOptions): Promise<LoginResult> {
  const {
    configDir,
    apiUrl,
    dev = false,
    timeoutMs = 120_000,
    force = false,
    openBrowser: openBrowserFn,
    generateNonce,
    code,
    fetch: fetchFn = globalThis.fetch,
  } = options;
  // log is accessed via options.log below (not destructured to avoid shadowing)

  // A caller that resolved the host from an explicit --host / PEW_HOST
  // override asks for an isolated config file, so its token never overwrites
  // the SaaS default's credentials (spec §4.5).
  const configManager = new ConfigManager(
    configDir,
    dev,
    credentialHostScope(options.hostIsolation),
  );

  // 1. Check existing login
  if (!force) {
    const existing = await configManager.load();
    if (existing.token) {
      return { success: true, alreadyLoggedIn: true };
    }
  }

  // 2. Code-based login flow (headless)
  if (code) {
    return executeCodeLogin(configManager, apiUrl, code, fetchFn);
  }

  // 3. Browser-based OAuth login flow
  const logFn = options.log ?? ((msg: string) => console.log(msg));
  const result = await performLogin({
    openBrowser: openBrowserFn,
    onSaveToken: (token) => {
      configManager.write({ token });
    },
    apiUrl,
    timeoutMs,
    generateNonce,
    accentColor: PEW_ACCENT_COLOR,
    log: logFn,
  });

  return {
    success: result.success,
    email: result.email,
    error: result.error,
  };
}

// ---------------------------------------------------------------------------
// Code-based login (headless)
// ---------------------------------------------------------------------------

interface CodeVerifyResponse {
  api_key?: string;
  email?: string;
  error?: string;
}

async function executeCodeLogin(
  configManager: ConfigManager,
  apiUrl: string,
  code: string,
  fetchFn: typeof globalThis.fetch,
): Promise<LoginResult> {
  try {
    const response = await fetchFn(`${apiUrl}/api/auth/code/verify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code }),
    });

    const data = (await response.json()) as CodeVerifyResponse;

    if (!response.ok) {
      return {
        success: false,
        error: data.error ?? `Server returned ${response.status}`,
      };
    }

    if (!data.api_key) {
      return {
        success: false,
        error: "No API key returned",
      };
    }

    // Save the token
    configManager.write({ token: data.api_key });

    return {
      success: true,
      email: data.email,
    };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : "Network error",
    };
  }
}

// Re-export removed 2026-07-08 (G1 cleanup): callers use `openBrowser` from
// `@nocoo/base-cli` directly; this re-export had no consumers.
