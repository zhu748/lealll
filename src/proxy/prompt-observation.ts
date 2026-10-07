import type { ProxyConfig } from "../config/types.js";
import type { Format } from "../translator/types.js";
import type { PromptRewriteResult, PromptTextSnapshot } from "./prompt-rewrite.js";

export interface PromptObservation {
  id: string;
  model: string;
  format: Format | "responses";
  receivedAt: number;
  sentAt: number | null;
  attempts: number;
  received: PromptTextSnapshot;
  upstream: PromptTextSnapshot | null;
  rewrite: PromptRewriteResult | null;
}

// One bounded pair per running server; prompt content is never persisted or logged here.
const latest = new WeakMap<ProxyConfig, PromptObservation>();

export function beginPromptObservation(
  config: ProxyConfig,
  input: Pick<PromptObservation, "id" | "model" | "format" | "receivedAt" | "received">,
): PromptObservation {
  const observation: PromptObservation = { ...input, sentAt: null, attempts: 0, upstream: null, rewrite: null };
  latest.set(config, observation);
  return observation;
}

/** Called by the actual send callback, after routing/signing and every plan rebuild. */
export function recordPromptDispatch(
  config: ProxyConfig,
  observation: PromptObservation,
  upstream: PromptTextSnapshot,
  rewrite: PromptRewriteResult | null,
): void {
  // A slow retry from an earlier request must not replace a newer received prompt.
  if (latest.get(config) !== observation) return;
  observation.upstream = upstream;
  observation.rewrite = rewrite;
  observation.sentAt = Date.now();
  observation.attempts++;
}

export function latestPromptObservation(config: ProxyConfig): PromptObservation | null {
  return latest.get(config) ?? null;
}

export function clearPromptObservation(config: ProxyConfig): void {
  latest.delete(config);
}
