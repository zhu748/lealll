export class RequestBodyLimitError extends Error {
  constructor(public readonly limit: number) {
    super(`body exceeds ${limit} byte cap`);
    this.name = "RequestBodyLimitError";
  }
}

/** Read a body once, bounding chunked input and always releasing its reader. */
export async function readRequestBytes(
  req: Request,
  maxBytes?: number,
  tooLarge: (limit: number) => Error = limit => new RequestBodyLimitError(limit),
): Promise<Uint8Array> {
  const cap = typeof maxBytes === "number" && Number.isFinite(maxBytes) && maxBytes > 0 ? maxBytes : 0;
  if (cap === 0) return new Uint8Array(await req.arrayBuffer());

  const declared = Number.parseInt(req.headers.get("content-length") ?? "", 10);
  if (Number.isFinite(declared) && declared > cap) throw tooLarge(cap);
  if (!req.body) return new Uint8Array(0);

  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      // Do not cancel on overflow: Bun's node:http adapter can commit an empty
      // 200 on source cancellation, hiding the caller's 413. The server closes
      // the connection after writing the error; unread input stays backpressured.
      if (total > cap) throw tooLarge(cap);
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  if (chunks.length === 1) return chunks[0];
  return Buffer.concat(chunks, total);
}
