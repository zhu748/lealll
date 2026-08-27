// @ts-nocheck
/**
 * captcha-guest-rejections.test.ts — v0.3.6.1 regression tests.
 *
 * The user-visible bug (reported against the v0.3.6.0 Windows exe): every
 * startup / captcha solve wave printed
 *
 *   [unhandledRejection] TypeError: L[$] is not a function. (In 'L[$](to)', ...)
 *       at p (https://g.alicdn.com/captcha-frontend/FeiLin/1.5.1/feilin149....js:1:220532)
 *       at <anonymous> (https://g.alicdn.com/captcha-frontend/FeiLin/1.5.1/feilin149....js:1:142309)
 *       ...
 *       at getUniversalCombatFeature (https://g.alicdn.com/captcha-frontend/FeiLin/1.5.1/feilin149....js:1:240199)
 *
 * FeiLin races best-effort async fingerprint collectors with no catch
 * handlers; under Bun they run in the host realm, so their rejections reach
 * the process-level unhandledRejection handler, which printed them
 * unconditionally. The fix classifies by STACK FRAME (alicdn.com URL) and
 * routes guest-origin errors into a bounded silent collector surfaced only on
 * solve failure.
 *
 * Classification MUST be frame-based, not message-based: a host-side
 * fetch("https://o.alicdn.com/...") network failure legitimately carries the
 * URL in its MESSAGE while its stack frames are host/native — those are real
 * host errors and must keep printing.
 */
import { describe, it, expect, beforeEach } from "bun:test";
import {
  isGuestOriginError,
  noteGuestError,
  peekGuestErrorNotes,
  guestErrorNoteCount,
  _resetGuestErrorNotesForTest,
} from "./captcha-guest-rejections.js";

// Exact stack shape from the user's Windows report (feilin149 chunk).
const FEILIN_STACK = [
  "TypeError: L[$] is not a function. (In 'L[$](to)', 'L[$]' is undefined)",
  "    at p (https://g.alicdn.com/captcha-frontend/FeiLin/1.5.1/feilin149.b9d088.js:1:220532)",
  "    at <anonymous> (https://g.alicdn.com/captcha-frontend/FeiLin/1.5.1/feilin149.b9d088.js:1:142309)",
  "    at e (https://g.alicdn.com/captcha-frontend/FeiLin/1.5.1/feilin149.b9d088.js:1:140661)",
  "    at new Promise (native:1:11)",
  "    at getUniversalCombatFeature (https://g.alicdn.com/captcha-frontend/FeiLin/1.5.1/feilin149.b9d088.js:1:240199)",
].join("\n");

// The Linux repro shape: collector continuation after destroyDom removed the
// global aliases (bare `window` / `Screen` references).
const POST_DESTROY_STACK = [
  "ReferenceError: window is not defined",
  "    at <anonymous> (https://g.alicdn.com/captcha-frontend/FeiLin/1.5.1/feilin149.b9d088.js:1:277752)",
  "    at e (https://g.alicdn.com/captcha-frontend/FeiLin/1.5.1/feilin149.b9d088.js:1:140661)",
  "    at processTicksAndRejections (native:7:39)",
].join("\n");

beforeEach(() => {
  _resetGuestErrorNotesForTest();
});

describe("isGuestOriginError (v0.3.6.1)", () => {
  it("classifies the exact user-reported FeiLin rejection (feilin149, L[$] is not a function) as guest", () => {
    const err = new TypeError("L[$] is not a function");
    err.stack = FEILIN_STACK;
    expect(isGuestOriginError(err)).toBe(true);
  });

  it("classifies post-destroy window/Screen rejections as guest", () => {
    const err = new ReferenceError("window is not defined");
    err.stack = POST_DESTROY_STACK;
    expect(isGuestOriginError(err)).toBe(true);
  });

  it("matches the main SDK host too (o.alicdn.com AliyunCaptcha.js frames)", () => {
    const err = new Error("x");
    err.stack = "Error: x\n    at ev (https://o.alicdn.com/captcha-frontend/aliyunCaptcha/AliyunCaptcha.js:1:299965)";
    expect(isGuestOriginError(err)).toBe(true);
  });

  it("does NOT classify a host fetch failure whose MESSAGE mentions alicdn (stack frames are host/native)", () => {
    const err = new Error("Unable to connect to https://o.alicdn.com/captcha-frontend/aliyunCaptcha/AliyunCaptcha.js");
    err.stack = [
      "Error: Unable to connect to https://o.alicdn.com/captcha-frontend/aliyunCaptcha/AliyunCaptcha.js",
      "    at fetch (native:1:1)",
      "    at createDom (/app/src/proxy/captcha-happy.ts:1590:18)",
    ].join("\n");
    expect(isGuestOriginError(err)).toBe(false);
  });

  it("does NOT classify pure host stacks (our source files, no alicdn frames)", () => {
    const err = new Error("setTimeout is not defined");
    err.stack = [
      "ReferenceError: setTimeout is not defined",
      "    at sseHeartbeat (/app/src/proxy/sse-heartbeat.ts:42:7)",
      "    at processTicksAndRejections (native:7:39)",
    ].join("\n");
    expect(isGuestOriginError(err)).toBe(false);
  });

  it("does NOT classify non-Error rejections (no stack to attribute by)", () => {
    expect(isGuestOriginError("TypeError: L[$] is not a function")).toBe(false);
    expect(isGuestOriginError(undefined)).toBe(false);
    expect(isGuestOriginError(null)).toBe(false);
    expect(isGuestOriginError({ message: "boom" })).toBe(false);
  });

  it("does NOT classify an Error with an empty stack", () => {
    const err = new Error("no stack");
    err.stack = "";
    expect(isGuestOriginError(err)).toBe(false);
  });
});

describe("noteGuestError collection (v0.3.6.1)", () => {
  it("consumes guest-origin rejections and collects a formatted note", () => {
    const err = new TypeError("L[$] is not a function");
    err.stack = FEILIN_STACK;
    expect(noteGuestError(err)).toBe(true);
    expect(guestErrorNoteCount()).toBe(1);
    const notes = peekGuestErrorNotes();
    expect(notes.length).toBe(1);
    expect(notes[0]).toContain("L[$] is not a function");
    expect(notes[0]).toContain("feilin149");
    expect(notes[0]).toContain("p (https://g.alicdn.com");
  });

  it("does NOT consume host errors (they keep printing at the call site)", () => {
    const host = new Error("real server error");
    host.stack = "Error: real server error\n    at handler (/app/src/proxy/handler.ts:1:1)";
    expect(noteGuestError(host)).toBe(false);
    expect(guestErrorNoteCount()).toBe(0);
    expect(noteGuestError("string rejection")).toBe(false);
    expect(guestErrorNoteCount()).toBe(0);
  });

  it("keeps the TAIL bounded at 40 notes (same policy as __capGuestErrors)", () => {
    const err = new Error("probe");
    err.stack = "Error: probe\n    at p (https://g.alicdn.com/captcha-frontend/FeiLin/1.5.1/feilin148.js:1:1)";
    for (let i = 0; i < 50; i++) noteGuestError(err);
    expect(guestErrorNoteCount()).toBe(40);
    expect(peekGuestErrorNotes(2).length).toBe(2);
    expect(peekGuestErrorNotes(100).length).toBe(40);
  });

  it("peek does not clear the collector (parallel solves share it)", () => {
    const err = new Error("probe");
    err.stack = "Error: probe\n    at p (https://g.alicdn.com/x.js:1:1)";
    noteGuestError(err);
    expect(peekGuestErrorNotes(4).length).toBe(1);
    expect(guestErrorNoteCount()).toBe(1);
    expect(peekGuestErrorNotes(4).length).toBe(1);
  });
});
