import { describe, expect, it } from "bun:test";
import {
  buildCaptchaConfigUrl,
  extractAliyunCaptchaVerifyParam,
  isAliyunCaptchaDeferredInteractive,
  isAliyunCaptchaTerminalPass,
  resolveCaptchaLanguage,
  resolveCaptchaSolverStrategy,
  resolveClientPlatformKey,
} from "./captcha.js";

describe("Aliyun captcha SDK result parsing", () => {
  it("extracts verify params from official lower-case and upper-case fields", () => {
    expect(extractAliyunCaptchaVerifyParam({ captchaVerifyParam: "  lower-token  " })).toBe("lower-token");
    expect(extractAliyunCaptchaVerifyParam({ CaptchaVerifyParam: "  upper-token  " })).toBe("upper-token");
    expect(extractAliyunCaptchaVerifyParam({ captchaVerifyParam: "   " })).toBeUndefined();
    expect(extractAliyunCaptchaVerifyParam("not-object")).toBeUndefined();
  });

  it("recognizes terminal pass states used by the official client", () => {
    expect(isAliyunCaptchaTerminalPass({ success: true, verifyResult: true })).toBe(true);
    expect(isAliyunCaptchaTerminalPass({ verifyCode: "T006" })).toBe(true);
    expect(isAliyunCaptchaTerminalPass({ VerifyCode: "T006" })).toBe(true);
    expect(isAliyunCaptchaTerminalPass({ success: true, verifyResult: false })).toBe(false);
  });

  it("detects deferred interactive states only when no verify param is available", () => {
    expect(isAliyunCaptchaDeferredInteractive({ success: true, verifyResult: false })).toBe(true);
    expect(isAliyunCaptchaDeferredInteractive({ success: true, verifyResult: true })).toBe(true);
    expect(isAliyunCaptchaDeferredInteractive({ success: true, verifyResult: true, captchaVerifyParam: "token" })).toBe(false);
    expect(isAliyunCaptchaDeferredInteractive({ VerifyCode: "T006" })).toBe(true);
    expect(isAliyunCaptchaDeferredInteractive({ VerifyCode: "T006", CaptchaVerifyParam: "token" })).toBe(false);
  });

  it("keeps the existing F001 interactive fallback classification", () => {
    expect(isAliyunCaptchaDeferredInteractive({ verifyCode: "F001" })).toBe(true);
    expect(isAliyunCaptchaDeferredInteractive({ code: "F001" })).toBe(true);
  });
});

describe("captcha solver strategy", () => {
  it("normalizes unsupported values to auto", () => {
    expect(resolveCaptchaSolverStrategy(undefined)).toBe("auto");
    expect(resolveCaptchaSolverStrategy("")).toBe("auto");
    expect(resolveCaptchaSolverStrategy("bogus")).toBe("auto");
  });

  it("accepts chrome and jsdom case-insensitively", () => {
    expect(resolveCaptchaSolverStrategy("chrome")).toBe("chrome");
    expect(resolveCaptchaSolverStrategy(" CHROME ")).toBe("chrome");
    expect(resolveCaptchaSolverStrategy("jsdom")).toBe("jsdom");
    expect(resolveCaptchaSolverStrategy(" JSDOM ")).toBe("jsdom");
  });
});

describe("ZCode captcha client config alignment", () => {
  it("builds the official client configs query with app version and platform", () => {
    const url = new URL(buildCaptchaConfigUrl({ appVersion: "3.2.0", platform: "linux-x64" }));
    expect(url.origin + url.pathname).toBe("https://zcode.z.ai/api/v1/client/configs");
    expect(url.searchParams.get("app_version")).toBe("3.2.0");
    expect(url.searchParams.get("platform")).toBe("linux-x64");
  });

  it("defaults client config platform to process.platform-process.arch", () => {
    expect(resolveClientPlatformKey()).toBe(`${process.platform}-${process.arch}`);
    const url = new URL(buildCaptchaConfigUrl({ appVersion: "3.1.8" }));
    expect(url.searchParams.get("platform")).toBe(resolveClientPlatformKey());
  });

  it("normalizes official captcha language values", () => {
    expect(resolveCaptchaLanguage("cn")).toBe("cn");
    expect(resolveCaptchaLanguage("zh-CN")).toBe("cn");
    expect(resolveCaptchaLanguage("en-US")).toBe("en");
    expect(resolveCaptchaLanguage("unknown")).toMatch(/^(cn|en)$/);
  });
});
