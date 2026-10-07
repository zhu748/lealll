/** Proxy-line parsing and URL validation; no pool state or network access. */
import { PROXY_PROTOCOLS, validateProxyUrl, metadataOrUnspecifiedIpReason } from "../utils/proxy-url.js";

export function validateProxySourceUrl(raw: string): { ok: true; url: string } | { ok: false; message: string } {
  const trimmed = raw.trim();
  if (!trimmed) return { ok: false, message: "source URL cannot be empty" };

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { ok: false, message: `Invalid source URL: ${trimmed}` };
  }

  const scheme = parsed.protocol.toLowerCase();
  if (scheme !== "http:" && scheme !== "https:") {
    return { ok: false, message: `Source URL scheme "${parsed.protocol}" is not allowed. Use http:// or https://` };
  }
  const host = parsed.hostname;
  if (!host) return { ok: false, message: "Source URL is missing a hostname" };
  if (parsed.port === "0") return { ok: false, message: "Source URL port must be between 1 and 65535" };

  const blocked = metadataOrUnspecifiedIpReason(host);
  if (blocked) {
    return {
      ok: false,
      message: `Source URL host "${host}" is a ${blocked} — fetching proxy lists from cloud metadata or unspecified addresses is blocked.`,
    };
  }

  return { ok: true, url: trimmed };
}

/** Stable persisted ID; retain the existing FNV-derived format across imports. */
export function proxyIdForUrl(url: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < url.length; i++) {
    h ^= url.charCodeAt(i);
    h = (h * 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

/**
 * Normalize a raw proxy line into a valid URL string.
 * - Empty / comment lines return null.
 * - Bare `host:port` becomes `http://host:port`.
 * - URLs without scheme get `http://` prepended.
 * - Invalid schemes / hosts return null.
 */
export function normalizeProxyLine(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("#")) return null;

  let candidate = trimmed;
  // If it has no scheme, prepend http://
  if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(candidate)) {
    // Heuristic: if it looks like `host:port` or `user:pass@host:port`, prepend http://
    candidate = `http://${candidate}`;
  }

  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    return null;
  }
  if (!PROXY_PROTOCOLS.includes(parsed.protocol)) return null;
  if (!parsed.hostname) return null;
  // Reject HTML/JS metacharacters in the host (defense-in-depth, mirrors
  // setAccountProxy validation).
  if (/[<>'"\s]/.test(parsed.host)) return null;

  // Re-serialize without hash/fragment and without trailing slash.
  const port = parsed.port ? `:${parsed.port}` : "";
  const auth = parsed.username
    ? `${encodeURIComponent(parsed.username)}${parsed.password ? ":" + encodeURIComponent(parsed.password) : ""}@`
    : "";
  return `${parsed.protocol}//${auth}${parsed.hostname}${port}`;
}

/** Parse a multi-line text block into a list of normalized proxy URLs. */
export function parseProxyText(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  let lineStart = 0;
  for (;;) {
    const lineEnd = text.indexOf("\n", lineStart);
    const end = lineEnd < 0 ? text.length : lineEnd;
    const line = text.slice(lineStart, end);
    const norm = normalizeProxyLine(line);
    if (norm && !seen.has(norm)) {
      seen.add(norm);
      out.push(norm);
    }
    if (lineEnd < 0) break;
    lineStart = lineEnd + 1;
  }
  return out;
}

/**
 * Run SSRF / scheme validation on a normalized URL. Returns null if valid,
 * or an error message string. Shares `validateProxyUrl` for parity
 * with the per-account proxy gate.
 */
export function proxyValidationError(normalized: string): string | null {
  const v = validateProxyUrl(normalized);
  return v.ok ? null : v.message;
}
