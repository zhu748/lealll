/** Claim, quota and coding-plan reset commands. */
import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { loadConfig } from "../config/loader.js";
import { resolveConfiguredCredential } from "../auth/selection.js";
import { ensureIdentitySelfHeal } from "../runtime/identity-config.js";

export async function claimCommand(args: string[]): Promise<void> {
  const sub = args[0] ?? "now";
  if (sub !== "list" && sub !== "now") {
    console.error("Usage: zcode-proxy claim [list|now]");
    process.exit(1);
  }
  const path = process.env.ZCODE_PROXY_CONFIG ?? "config.yaml";
  if (!existsSync(path)) {
    console.error(`Config file not found: ${path} (run serve once or create it).`);
    process.exit(1);
  }
  // The billing gateway requires a stable X-Device-Mid — self-heal configs
  // created before the deviceMid feature (idempotent: reuses existing value),
  // and refresh a template-era appVersion pin (campaign list gate).
  ensureIdentitySelfHeal(path);
  const config = loadConfig(path);
  try {
    const { runClaimCli } = await import("../claim/runtime.js");
    await runClaimCli(config, sub);
  } catch (err) {
    console.error(`claim failed: ${(err as Error).message}`);
    process.exit(1);
  }
}

/**
 * `quota` subcommand — print the live quota snapshot: per-model credit buckets
 * (billing plane) and coding-plan usage windows (monitor plane). Reuses
 * collectQuotaSnapshot (same path GET /quota serves).
 */
export async function quotaCommand(): Promise<void> {
  const path = process.env.ZCODE_PROXY_CONFIG ?? "config.yaml";
  if (!existsSync(path)) {
    console.error(`Config file not found: ${path} (run serve once or create it).`);
    process.exit(1);
  }
  ensureIdentitySelfHeal(path);
  const config = loadConfig(path);
  try {
    const { collectQuotaSnapshot } = await import("../server/routes-quota.js");
    const snap = await collectQuotaSnapshot(config);
    if (snap.balances.length === 0) {
      console.log("No balance windows reported by the billing endpoint.");
    }
    for (const b of snap.balances) {
      const exp = b.expiresAt ? ` · expires ${fmtQuotaExpiry(b.expiresAt)}` : "";
      console.log(`  ${b.showName || "(unnamed)"}: ${b.remainingUnits.toLocaleString("en-US")} / ${b.totalUnits.toLocaleString("en-US")} units${exp}`);
    }
    if (snap.codingPlan) {
      const { level, limits } = snap.codingPlan;
      if (limits.length === 0) {
        console.log("No coding-plan usage windows reported by the monitor endpoint.");
      }
      for (const l of limits) {
        const tier = level ? ` (${level})` : "";
        // Mirror of the official panel: remaining only — upstream `number` is
        // not a comparable total (live TIME_LIMIT row: remaining=3894, number=1).
        const amount =
          l.remaining !== undefined
            ? `${l.remaining.toLocaleString("en-US")}${l.unit ? ` ${l.unit}` : ""} remaining`
            : "no usage numbers reported";
        const reset = l.nextResetTime !== undefined ? ` · resets ${fmtQuotaExpiry(l.nextResetTime)}` : "";
        console.log(`  coding-plan${tier}: [${l.type}] ${amount}${reset}`);
      }
    }
    for (const plan of snap.claimablePlans) {
      const grants = plan.entitlements
        .map((e) => `${e.showName || plan.name}: ${(e.grantUnits ?? 0).toLocaleString("en-US")} ${e.unitType}`)
        .join("; ");
      console.log(`  claimable: ${plan.name}${grants ? ` (${grants})` : ""}`);
    }
    for (const err of snap.errors) console.error(`  ⚠ ${err}`);
    if (snap.errors.length > 0) process.exitCode = 1;
  } catch (err) {
    console.error(`quota query failed: ${(err as Error).message}`);
    process.exit(1);
  }
}

/** `YYYY-MM-DD HH:mm` local time; `expiresAt` may be seconds or milliseconds. */
function fmtQuotaExpiry(expiresAt: number): string {
  const d = new Date(expiresAt > 1e12 ? expiresAt : expiresAt * 1000);
  if (Number.isNaN(d.getTime())) return String(expiresAt);
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * `zcode-proxy reset` — coding-plan usage-window resets (desktop 3.14.4
 * alignment, 4.7.2-fork.1).
 *
 *   zcode-proxy reset                     Show available reset entitlements
 *   zcode-proxy reset --use five_hour     Spend a 5-hour-window reset
 *   zcode-proxy reset --use week          Spend a weekly-window reset
 *   zcode-proxy reset --opportunity       Ask the server for an automatic grant
 *   zcode-proxy reset --key=<id>          Explicit idempotency key (default: UUID)
 *
 * Reset entitlements are earned server-side (rewards etc.); spending one
 * clears the coding-plan usage window without waiting for the natural
 * rollover. Requires the dual reset tokens — accounts logged in before
 * 4.7.2-fork.1 must re-login to capture `maasToken`.
 */
export async function resetCommand(args: string[]): Promise<void> {
  const useFlag = args.find(a => a === "--use" || a.startsWith("--use="));
  const opportunity = args.includes("--opportunity");
  const keyFlag = args.find(a => a.startsWith("--key="));
  const idempotencyKey = keyFlag ? keyFlag.slice("--key=".length) : randomUUID();

  const path = process.env.ZCODE_PROXY_CONFIG ?? "config.yaml";
  if (!existsSync(path)) {
    console.error(`Config file not found: ${path} (run serve once or create it).`);
    process.exit(1);
  }
  const config = loadConfig(path);
  const cred = await resolveConfiguredCredential(config);
  if (!cred) {
    console.error("Not logged in. Run: zcode-proxy auth login");
    process.exit(1);
  }

  const { createResetClient, normalizeResetType, ResetAuthMissingError } = await import("../auth/reset.js");
  const client = createResetClient(cred, {
    origin: config.claim.origin || undefined,
    identity: config.identity,
  });

  try {
    if (useFlag) {
      // `--use five_hour` (flag value in the next arg) or `--use=five_hour`.
      const raw = useFlag === "--use"
        ? args[args.indexOf(useFlag) + 1] ?? ""
        : useFlag.slice("--use=".length);
      const type = normalizeResetType(raw);
      const used = await client.use(type, idempotencyKey);
      console.log(`Reset used (${type}): ${used ? "success" : "not applied"}`);
      console.log("Usage windows refresh on the next quota query.");
      return;
    }

    if (opportunity) {
      const opp = await client.requestOpportunity(idempotencyKey);
      if (opp.granted) {
        console.log("Opportunity granted — an automatic reset is available (see: zcode-proxy reset).");
      } else {
        console.log(`No opportunity yet — next try: ${opp.nextTryAt !== null ? fmtQuotaExpiry(opp.nextTryAt) : "(server did not say)"}`);
      }
      return;
    }

    const status = await client.getStatus();
    const five = status.availableFiveHourResets.length;
    const week = status.availableWeekResets.length;
    console.log(`Coding-plan resets for ${config.provider}${cred.email ? ` (${cred.email})` : ""}:`);
    console.log(`  5-hour window resets: ${five}`);
    for (const r of status.availableFiveHourResets) {
      console.log(`    · expires ${fmtQuotaExpiry(r.expireAt)}`);
    }
    console.log(`  weekly window resets: ${week}`);
    for (const r of status.availableWeekResets) {
      console.log(`    · expires ${fmtQuotaExpiry(r.expireAt)}`);
    }
    if (status.latestFiveHourResetHistory) {
      console.log(`  last 5h reset used:   ${fmtQuotaExpiry(status.latestFiveHourResetHistory.usedAt)}`);
    }
    if (status.latestWeekResetHistory) {
      console.log(`  last week reset used: ${fmtQuotaExpiry(status.latestWeekResetHistory.usedAt)}`);
    }
    if (five === 0 && week === 0) {
      console.log("\nNo resets available. They are granted server-side (rewards/events) or via --opportunity.");
    } else {
      console.log("\nSpend one with: zcode-proxy reset --use five_hour | --use week");
    }
  } catch (err) {
    if (err instanceof ResetAuthMissingError) {
      console.error(`reset unavailable: ${(err as Error).message}`);
    } else {
      console.error(`reset command failed: ${(err as Error).message}`);
    }
    process.exit(1);
  }
}
