/**
 * Timing-safe string comparison.
 *
 * Compares two strings in constant time relative to the longer one, so that
 * an attacker cannot use response-time differences to bitwise-recover a
 * secret. Always iterates over the full length of the longer string — never
 * short-circuits on the first differing character.
 *
 * @returns true iff both strings are byte-equal AND have the same length.
 */
export function timingSafeEqual(a: string, b: string): boolean {
  // To avoid leaking length information, always compare the full length of
  // the longer string. If the lengths differ, we still do a full pass so the
  // total work is constant w.r.t. max(a.length, b.length); the result is
  // guaranteed false because the XOR-fold of differing lengths is non-zero.
  const maxLen = Math.max(a.length, b.length);
  let result = a.length ^ b.length; // Non-zero if lengths differ
  for (let i = 0; i < maxLen; i++) {
    const aChar = i < a.length ? a.charCodeAt(i) : 0;
    const bChar = i < b.length ? b.charCodeAt(i) : 0;
    result |= aChar ^ bChar;
  }
  return result === 0;
}
