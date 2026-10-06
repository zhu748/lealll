import type { AuthManager } from "../auth/manager.js";
import type { ProxyConfig } from "../config/types.js";
export interface AdminOptions {
  config: ProxyConfig;
  auth: AuthManager;
  configPath: string;
  startTime: number;
  /**
   * Optional fetch override for outbound requests made by admin handlers
   * (currently used by /admin/api/accounts/proxy-test). Defaults to the
   * global fetch. Test code passes a mock here to avoid real network calls.
   */
  fetchImpl?: typeof fetch;
  /**
   * Resolve the TCP-remote client IP for a request. In production this is
   * wired to Bun's `server.requestIP(req)?.address`, which reads the real
   * socket peer address and CANNOT be spoofed by headers. When omitted
   * (e.g., in tests where there is no real socket), client IP detection
   * falls back to "unknown" — and the loopback gate then defaults to
   * allowing the request (preserving the legacy dev behavior for direct
   * local connections).
   *
   * X-Forwarded-For / X-Real-IP are NEVER trusted unless the operator
   * explicitly opts in via `config.server.trustProxy = true`.
   */
  resolveClientIp?: (req: Request) => string | undefined;
}

/** Parsed once by the authenticated dispatcher and shared by feature routes. */
export interface AdminRouteContext {
  req: Request;
  opts: AdminOptions;
  url: URL;
  path: string;
  method: string;
}

export type AdminRouteHandler = (context: AdminRouteContext) => Response | null | Promise<Response | null>;
