/**
 * The log pane: a bounded ring of leveled log lines with tail-following and
 * scrollback, mirroring the Android app's Logs card (LazyColumn that sticks
 * to the newest line). Pure state — the frame renderer and terminal glue
 * read it, tests drive it directly.
 */
import { stripAnsi } from "./width.js";

export type LogLevel = "info" | "warn" | "error";

export interface LogLine {
  readonly seq: number;
  readonly level: LogLevel;
  readonly text: string;
}

export interface LogView {
  /** The lines to draw, oldest first, at most `height` of them. */
  readonly lines: readonly LogLine[];
  /** Total lines retained (for the "Logs (N)" header). */
  readonly total: number;
  /** Lines hidden BELOW the viewport toward the tail (0 while following). */
  readonly fromBottom: number;
}

export class LogPane {
  private lines: LogLine[] = [];
  /** Logical start of live entries — the evicted dead prefix (ring amortization). */
  private head = 0;
  private nextSeq = 0;
  /** Lines hidden below the viewport. 0 = follow the tail. */
  private offset = 0;

  constructor(private readonly capacity = 2000) {}

  /**
   * Append a log record. ANSI escape sequences are stripped (proxy logs carry
   * color codes; the pane applies its own) and embedded newlines split into
   * separate rows so multi-line records scroll naturally.
   *
   * Eviction is amortized: overflows advance a `head` cursor (O(1)) and the
   * dead prefix is physically spliced out only when it grows to `capacity`
   * entries. The previous shape spliced(0,1) on EVERY line past capacity —
   * an O(n) memmove per pushed row at high log volume.
   */
  push(text: string, level: LogLevel = "info"): void {
    const clean = stripAnsi(String(text)).replace(/\r/g, "");
    const parts = clean.split("\n");
    if (parts.length > 1 && parts[parts.length - 1] === "") parts.pop();
    for (const part of parts) {
      this.lines.push({ seq: this.nextSeq++, level, text: part });
    }
    const live = this.lines.length - this.head;
    if (live > this.capacity) {
      this.head += live - this.capacity;
      if (this.head >= this.capacity) {
        this.lines.splice(0, this.head);
        this.head = 0;
      }
    }
  }

  get count(): number {
    return this.lines.length - this.head;
  }

  /** True when the viewport is pinned to the newest lines. */
  get following(): boolean {
    return this.offset === 0;
  }

  scrollUp(n: number): void {
    this.offset = Math.min(this.count, this.offset + Math.max(0, n));
  }

  scrollDown(n: number): void {
    this.offset = Math.max(0, this.offset - Math.max(0, n));
  }

  /** Jump back to the tail (re-enable following). */
  followBottom(): void {
    this.offset = 0;
  }

  clear(): void {
    this.lines = [];
    this.head = 0;
    this.offset = 0;
  }

  /** Slice of lines currently visible in a viewport `height` rows tall. */
  view(height: number): LogView {
    const rows = Math.max(1, height);
    const total = this.lines.length - this.head;
    // At max scrollback (offset === total) the viewport pins to the oldest
    // rows instead of going empty.
    const end = Math.max(Math.min(rows, total), total - this.offset);
    const start = Math.max(0, end - rows);
    return {
      lines: this.lines.slice(this.head + start, this.head + end),
      total,
      fromBottom: total - end,
    };
  }
}
