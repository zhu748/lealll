/**
 * Incremental VT/ANSI input parser for the TUI keyboard loop.
 *
 * stdin is read in raw mode as a UTF-8 string stream; `KeyParser.feed`
 * converts chunks into actions. A chunk can end in the middle of an escape
 * sequence (lone `\x1b` before more bytes arrive), so unconsumed input is
 * buffered until the sequence completes on a later chunk. Works identically
 * under Bun and Node — no readline keypress events involved.
 *
 * Mouse: with SGR mouse tracking enabled (`\x1b[?1000h\x1b[?1006h`), the
 * terminal reports presses/releases as `ESC [ < b ; x ; y M/m` and wheel
 * events as button codes 64/65 — parsed into click/wheel actions so TUI
 * buttons are directly clickable (coordinates arrive 1-based, converted
 * to 0-based terminal cells).
 */

export type KeyAction =
  | { type: "char"; key: string }
  | { type: "up" }
  | { type: "down" }
  | { type: "pageup" }
  | { type: "pagedown" }
  | { type: "home" }
  | { type: "end" }
  | { type: "click"; x: number; y: number }
  | { type: "wheel-up" }
  | { type: "wheel-down" }
  | { type: "ctrl-c" }
  /** Recognized but without a binding (Enter, Tab, bare Esc, Alt+key, drag/release, …). */
  | { type: "ignore" };

/**
 * Inter-byte budget for escape sequences: a lone ESC pending longer than
 * this is treated as a bare ESC keypress (flushed) instead of a sequence
 * prefix waiting for its continuation.
 */
const ESC_LONE_FLUSH_MS = 50;

export class KeyParser {
  private pending = "";
  /** Wall-clock ms when the current pending tail became a lone ESC (0 = none). */
  private pendingEscAt = 0;

  /** Consume a raw stdin chunk and return the actions it completes. */
  feed(chunk: string): KeyAction[] {
    // Wedge guard: no real sequence is anywhere near 64 bytes (SGR mouse is
    // ~16), so a pending tail this long means the parser is stuck on garbage.
    // Drop it — otherwise the stuck prefix would swallow every future chunk
    // and the TUI would stop responding to keys and clicks for good.
    if (this.pending.length > 64) {
      this.pending = "";
      this.pendingEscAt = 0;
    }
    const actions: KeyAction[] = [];
    let buf: string;
    if (
      this.pending === "\x1b" &&
      this.pendingEscAt > 0 &&
      Date.now() - this.pendingEscAt >= ESC_LONE_FLUSH_MS
    ) {
      // A lone ESC that has outlived the escape-sequence inter-byte budget is
      // a BARE ESC keypress: flush it instead of merging the incoming chunk
      // into Alt+key (which silently swallowed the user's next keypress —
      // ESC then q did not quit). Genuine split sequences complete in well
      // under the budget, so the cross-chunk contract is preserved.
      actions.push({ type: "ignore" });
      buf = chunk;
      this.pending = "";
    } else {
      buf = this.pending + chunk;
    }
    this.pendingEscAt = 0;
    let i = 0;

    while (i < buf.length) {
      const ch = buf[i]!;

      if (ch === "\x1b") {
        if (i + 1 >= buf.length) break; // lone ESC at chunk end — wait for the rest
        if (buf[i + 1] === "[") {
          let j = i + 2;
          while (j < buf.length && !/[A-Za-z~]/.test(buf[j]!)) j++;
          if (j >= buf.length) break; // incomplete CSI — wait
          actions.push(csiAction(buf[j]!, buf.slice(i + 2, j)));
          i = j + 1;
          continue;
        }
        if (buf[i + 1] === "O") {
          if (i + 2 >= buf.length) break; // incomplete SS3 — wait
          actions.push(csiAction(buf[i + 2]!, ""));
          i += 3;
          continue;
        }
        // Alt+key or other two-byte sequence — no binding.
        actions.push({ type: "ignore" });
        i += 2;
        continue;
      }

      if (ch === "\x03") {
        actions.push({ type: "ctrl-c" });
        i++;
        continue;
      }

      if (ch < " " || ch === "\x7f") {
        // Remaining control bytes (Enter/Tab/backspace/…) carry no binding.
        actions.push({ type: "ignore" });
        i++;
        continue;
      }

      actions.push({ type: "char", key: ch });
      i++;
    }

    this.pending = buf.slice(i);
    // Track a lone trailing ESC so a LATER feed can age it out (see above);
    // incomplete sequences ("\x1b[", "\x1bOA") keep waiting indefinitely.
    if (this.pending === "\x1b") this.pendingEscAt = Date.now();
    return actions;
  }
}

function csiAction(final: string, params: string): KeyAction {
  if (params.startsWith("<")) return mouseAction(params.slice(1), final);
  switch (final) {
    case "A":
      return { type: "up" };
    case "B":
      return { type: "down" };
    case "H":
      return { type: "home" };
    case "F":
      return { type: "end" };
    case "~":
      if (params === "5" || params === "5;5") return { type: "pageup" };
      if (params === "6" || params === "6;5") return { type: "pagedown" };
      if (params === "1" || params === "7") return { type: "home" };
      if (params === "4" || params === "8") return { type: "end" };
      return { type: "ignore" };
    default:
      return { type: "ignore" };
  }
}

/** SGR mouse event: `<button;column;row` + `M` (press) or `m` (release). */
function mouseAction(params: string, final: string): KeyAction {
  if (final !== "M") return { type: "ignore" }; // releases and motion don't click
  const parts = params.split(";");
  const button = Number(parts[0]);
  const x = Number(parts[1]);
  const y = Number(parts[2]);
  if (!Number.isFinite(button) || !Number.isFinite(x) || !Number.isFinite(y)) {
    return { type: "ignore" };
  }
  if (button === 0) return { type: "click", x: x - 1, y: y - 1 };
  if (button === 64) return { type: "wheel-up" };
  if (button === 65) return { type: "wheel-down" };
  return { type: "ignore" }; // right/middle buttons, drag modifiers
}
