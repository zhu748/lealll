/**
 * OpenAI Responses API route handler: POST /v1/responses.
 *
 * Delegates to the shared proxy pipeline with format="openai-responses", which
 * triggers translation to/from Anthropic Messages upstream. This is the format
 * used by Codex CLI when `wire_api = "responses"`.
 */
import { proxyRequest, type ProxyHandlerOptions } from "../proxy/handler.js";

/** Handle POST /v1/responses — translate to Anthropic upstream and back to Responses format. */
export async function handleResponses(
  req: Request,
  opts: ProxyHandlerOptions,
): Promise<Response> {
  return proxyRequest(req, "openai-responses", opts);
}
