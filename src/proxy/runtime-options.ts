let reqCounter = 0;

export function nextReqId(): string {
  return `#${String(++reqCounter).padStart(3, "0")}`;
}

export function startPlanCaptchaPreflightEnabled(): boolean {
  const raw = process.env.ZCODE_STARTPLAN_CAPTCHA_PREFLIGHT?.trim().toLowerCase();
  if (!raw) return false;
  return raw === "1" || raw === "true" || raw === "on" || raw === "yes" || raw === "always";
}
