const ADMIN_ERROR_MESSAGE_MAX_CHARS = 1000;

export function truncateAdminErrorMessage(value: string): string {
  if (value.length <= ADMIN_ERROR_MESSAGE_MAX_CHARS) return value;
  const omitted = value.length - ADMIN_ERROR_MESSAGE_MAX_CHARS;
  return `${value.slice(0, ADMIN_ERROR_MESSAGE_MAX_CHARS)}...(truncated ${omitted} chars)`;
}

export function parseQueryLimit(raw: string | null, fallback: number, max: number): number {
  const trimmed = raw?.trim();
  if (!trimmed) return fallback;
  if (!/^\d+$/.test(trimmed)) return fallback;
  const n = Number(trimmed);
  if (!Number.isSafeInteger(n)) return fallback;
  return Math.min(n, max);
}
