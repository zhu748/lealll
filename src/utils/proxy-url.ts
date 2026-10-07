/** Accepted outbound-proxy protocols, shared by account validation and pool parsing. */
export const PROXY_PROTOCOLS: readonly string[] = [
  "http:", "https:", "socks4:", "socks4a:", "socks5:", "socks5h:",
];

/**
 * Validate a proxy URL's scheme and reject literal-IP hosts that point at
 * cloud-metadata or unspecified addresses. Exported for unit testing.
 *
 * v0.2.0.8 SSRF scope: we ONLY block the highest-risk targets:
 *   - 169.254.169.254 and the 169.254/16 link-local range (AWS/GCP/Azure
 *     metadata services, which can leak instance credentials)
 *   - 0.0.0.0/8 (unspecified — never a valid proxy target)
 *   - :: (IPv6 unspecified) and fe80::/10 (IPv6 link-local)
 *
 * We intentionally ALLOW loopback (127.0.0.1, ::1) and private ranges
 * (10/8, 172.16/12, 192.168/16) because local proxies (clash, v2ray,
 * squid) and internal corporate proxies are legitimate, common use cases
 * for this tool. Blocking them would break the primary deployment pattern
 * (local proxy on the user's laptop).
 *
 * Returns `{ok: true}` or `{ok: false, message}`. Does NOT perform DNS
 * resolution — a hostname-based proxy is the operator's responsibility.
 */
export function validateProxyUrl(url: string): { ok: true } | { ok: false; message: string } {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, message: `Invalid proxy URL: "${url}" is not a valid URL` };
  }
  const scheme = parsed.protocol.toLowerCase();
  if (!PROXY_PROTOCOLS.includes(scheme)) {
    return {
      ok: false,
      message: `Proxy URL scheme "${parsed.protocol}" is not allowed. Use http://, https://, socks4://, socks4a://, socks5://, or socks5h://`,
    };
  }
  const host = parsed.hostname;
  if (!host) {
    return { ok: false, message: "Proxy URL is missing a hostname" };
  }
  if (parsed.port === "0") {
    return { ok: false, message: "Proxy URL port must be between 1 and 65535" };
  }
  // Block only cloud-metadata / unspecified addresses (see SSRF scope above).
  const ipCheck = metadataOrUnspecifiedIpReason(host);
  if (ipCheck) {
    return {
      ok: false,
      message: `Proxy URL host "${host}" is a ${ipCheck} — routing upstream traffic to cloud metadata or unspecified addresses is blocked to prevent credential theft.`,
    };
  }
  return { ok: true };
}

/**
 * If `host` is a literal IP in a cloud-metadata or unspecified range,
 * return a short reason. Otherwise return null (allowed).
 *
 * Blocked ranges (see validateProxyUrl SSRF scope):
 *   - IPv4: 0.0.0.0/8, 169.254/16 (link-local + cloud metadata)
 *   - IPv6: :: (unspecified), fe80::/10 (link-local)
 *
 * Loopback, private, and ULA ranges are NOT blocked (legitimate local proxy use).
 */
export function metadataOrUnspecifiedIpReason(host: string): string | null {
  const ipHost = host.startsWith("[") && host.endsWith("]")
    ? host.slice(1, -1)
    : host;
  // IPv4 dotted-quad check.
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(ipHost)) {
    const parts = ipHost.split(".").map(Number);
    if (parts.some(p => p > 255)) return null; // not actually a valid IP
    const [a, b] = parts;
    if (a === 0) return "0.0.0.0/8 unspecified address";
    if (a === 169 && b === 254) return "169.254/16 link-local / cloud metadata endpoint";
    return null;
  }
  // IPv6 literals.
  const lower = ipHost.toLowerCase();
  if (lower === "::") return ":: unspecified";
  // fe80::/10 link-local (IPv6 equivalent of 169.254/16) — also block.
  if (lower.startsWith("fe8") || lower.startsWith("fe9") || lower.startsWith("fea") || lower.startsWith("feb")) {
    return "fe80::/10 IPv6 link-local";
  }
  return null;
}
