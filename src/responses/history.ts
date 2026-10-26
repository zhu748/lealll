/** Convert between Responses wire objects and the stored conversation history. */
import type { ResponsesInputItem, ResponsesOutputItem, ResponsesResponse } from "../translator/responses-types.js";
import type { StoredResponse } from "./store.js";

/**
 * Cast stored output items back into input items so the next turn's history is
 * a flat list the translator can walk. Responses output and input item shapes
 * overlap enough that a structural cast is sound (the fields we read — `type`,
 * `call_id`, `name`, `arguments`, `content`, `role` — are shared).
 */
export function outputItemsAsInputItems(outputs: ResponsesOutputItem[]): ResponsesInputItem[] {
  return outputs as unknown as ResponsesInputItem[];
}

export function buildStoredResponse(
  resp: ResponsesResponse,
  input: ResponsesInputItem[],
  instructions: string | undefined,
): StoredResponse {
  return {
    id: resp.id,
    model: resp.model,
    status: (resp.status === "completed" || resp.status === "incomplete" || resp.status === "failed" ? resp.status : "completed"),
    input,
    output: resp.output,
    usage: resp.usage,
    instructions,
    createdAt: Date.now(),
    lastAccessedAt: Date.now(),
  };
}
