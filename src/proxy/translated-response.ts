/**
 * Shared error-response helper (fork-merge architecture seam).
 *
 * Extracted from `proxy/handler.ts` into its own module so the dependency
 * graph stays acyclic:
 *
 *   proxy/handler → proxy/stats → admin/api → proxy/translated-response
 *
 * The fork's admin dashboard (and its request-body guards) need to emit the
 * same `{ error: { type, message } }` shape as the proxy handler; importing
 * it from handler.ts directly would make `admin/api → handler → stats →
 * admin/api` a load cycle. Both sides now import this leaf module instead.
 */

/** Build a JSON error response. */
export function errorResponse(status: number, type: string, message: string): Response {
  const body = JSON.stringify({
    error: { type, message },
  });
  return new Response(body, {
    status,
    headers: { "content-type": "application/json" },
  });
}
