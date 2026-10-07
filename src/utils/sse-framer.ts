import { SSE } from "./constants.js";

export class SSEFrameTooLargeError extends Error {
  constructor(limit: number) {
    super(`SSE event exceeds ${limit} byte buffer limit`);
    this.name = "SSEFrameTooLargeError";
  }
}

/**
 * Incremental SSE framing. Only newly decoded text is scanned; fragments are
 * joined once per event rather than copying and rescanning an unfinished frame
 * on every network read. CR, LF and CRLF may be split across reads or mixed.
 * Input is TextDecoder output; returned frames have normalized LF endings.
 */
export class SSEFramer {
  private parts: string[] = [];
  private bytes = 0;
  private lineLength = 0;
  private skipLF = false;

  constructor(private readonly maxBytes = SSE.MAX_TRANSLATED_STREAM_BUFFERED_EVENT_BYTES) {}

  *push(text: string): Generator<string> {
    let start = 0;
    if (this.skipLF && text.length > 0) {
      if (text.charCodeAt(0) === 10) start = 1;
      this.skipLF = false;
    }
    // Most LLM streams use LF. Scan complete frames directly in native string
    // code; retain the line-ending state machine for CR/CRLF and mixed input.
    if (text.indexOf("\r", start) < 0) {
      // The first LF may complete a blank line begun in the previous read.
      if (this.parts.length > 0 && this.lineLength === 0 && text.charCodeAt(start) === 10) {
        const frame = this.takeFrame();
        if (frame) yield frame;
        start++;
      }
      let end: number;
      while ((end = text.indexOf("\n\n", start)) >= 0) {
        let frame = text.slice(start, end);
        if (this.parts.length > 0) {
          this.append(frame);
          frame = this.takeFrame();
        } else if (Buffer.byteLength(frame, "utf8") > this.maxBytes) {
          throw new SSEFrameTooLargeError(this.maxBytes);
        }
        if (frame) yield frame;
        start = end + 2;
      }
      const tail = text.slice(start);
      this.append(tail);
      const lastLF = tail.lastIndexOf("\n");
      if (lastLF >= 0) this.lineLength = tail.length - lastLF - 1;
      return;
    }
    const endings = /[\r\n]/g;
    endings.lastIndex = start;
    let match: RegExpExecArray | null;
    while ((match = endings.exec(text)) !== null) {
      const end = match.index;
      this.append(text.slice(start, end));
      if (this.lineLength === 0) {
        const frame = this.takeFrame();
        if (frame) yield frame;
      } else {
        this.append("\n");
        this.lineLength = 0;
      }
      start = end + 1;
      if (match[0] === "\r") {
        if (text.charCodeAt(start) === 10) start++;
        else if (start === text.length) this.skipLF = true;
      }
      endings.lastIndex = start;
    }
    this.append(text.slice(start));
  }

  /** Emit the final event even when the upstream omitted its blank line. */
  *finish(tail = ""): Generator<string> {
    yield* this.push(tail);
    const frame = this.takeFrame();
    this.skipLF = false;
    if (frame) yield frame;
  }

  private takeFrame(): string {
    const frame = this.parts.length === 1 ? this.parts[0] : this.parts.join("");
    this.parts = [];
    this.bytes = 0;
    this.lineLength = 0;
    return frame;
  }

  private append(fragment: string): void {
    if (!fragment) return;
    this.bytes += Buffer.byteLength(fragment, "utf8");
    if (this.bytes > this.maxBytes) {
      this.parts = [];
      throw new SSEFrameTooLargeError(this.maxBytes);
    }
    this.parts.push(fragment);
    this.lineLength += fragment.length;
  }
}
