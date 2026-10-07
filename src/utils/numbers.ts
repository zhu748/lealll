/** Parse complete, non-negative safe integers; reject partial numeric strings. */
export function parseStrictNonNegativeInteger(raw: unknown): number | undefined {
  if (typeof raw === "number") {
    return Number.isSafeInteger(raw) && raw >= 0 ? raw : undefined;
  }
  if (raw === undefined || raw === null) return undefined;
  const trimmed = String(raw).trim();
  if (!/^\d+$/.test(trimmed)) return undefined;
  const n = Number(trimmed);
  return Number.isSafeInteger(n) ? n : undefined;
}
