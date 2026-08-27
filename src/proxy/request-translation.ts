import type { Format, OpenAIChatRequest, OpenAIResponseRequest } from "../translator/types.js";
import { translateRequestOpenAIToAnthropic } from "../translator/openai-to-anthropic.js";
import { translateRequestResponsesToAnthropic } from "../translator/responses-to-anthropic.js";
import { errorResponse } from "./translated-response.js";

export function translateClientBodyObj(
  parsed: unknown,
  format: Format,
  opts?: { forceThinkingModels?: string[] },
): Response | unknown {
  if (parsed === undefined || parsed === null) {
    return errorResponse(400, "translation_failed", `${format} request body is empty; cannot translate.`);
  }

  try {
    if (format === "openai-responses") {
      return translateRequestResponsesToAnthropic(
        parsed as OpenAIResponseRequest,
        opts?.forceThinkingModels ? { forceThinkingModels: opts.forceThinkingModels } : undefined,
      );
    }
    return translateRequestOpenAIToAnthropic(parsed as OpenAIChatRequest);
  } catch (err) {
    return errorResponse(400, "translation_failed", `${format}→Anthropic translation failed: ${(err as Error).message}`);
  }
}
