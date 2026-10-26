/** Bounded upstream response consumption; unlike request reads, overflow cancels the source. */
export class ResponseBodyLimitError extends Error {
  constructor(readonly limit: number) {
    super(`response body exceeds ${limit} byte cap`);
    this.name = "ResponseBodyLimitError";
  }
}

export async function readResponseBytes(response: Response, maxBytes: number): Promise<Buffer> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new TypeError("response byte cap must be a non-negative safe integer");
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    void response.body?.cancel().catch(() => {});
    throw new ResponseBodyLimitError(maxBytes);
  }
  if (!response.body) return Buffer.alloc(0);

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let complete = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) { complete = true; break; }
      total += value.byteLength;
      if (total > maxBytes) throw new ResponseBodyLimitError(maxBytes);
      chunks.push(value);
    }
    return Buffer.concat(chunks, total);
  } finally {
    if (!complete) void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
