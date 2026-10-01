import type { Credential, PlanId } from "./types.js";
import type { ProviderId } from "../provider/types.js";
import type { FetchFn } from "./oauth.js";

const ZAI_API_KEY_NAME = "zcode-api-key";
const DEFAULT_ORG_MARKER = "\u9ED8\u8BA4\u673A\u6784"; // 默认机构
const DEFAULT_PROJECT_MARKER = "\u9ED8\u8BA4\u9879\u76EE"; // 默认项目

async function requestBizApi(
  fetchImpl: FetchFn,
  url: string,
  authorization: string,
  init?: RequestInit,
): Promise<any> {
  const resp = await fetchImpl(url, {
    ...init,
    headers: {
      Authorization: authorization,
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
  if (!resp.ok) {
    throw new Error(`Biz API ${url} failed: ${resp.status}`);
  }
  const body = await resp.json();
  const code = body.code ?? body.status;
  if (code != null && code !== 0 && code !== 200 && code !== "0" && code !== "200") {
    throw new Error(body.msg ?? `Biz API error ${code}`);
  }
  return body.data ?? body;
}

export class KeyResolver {
  constructor(private fetchImpl: FetchFn = fetch) {}

  async resolveZaiBizToken(accessToken: string): Promise<string> {
    const resp = await this.fetchImpl("https://api.z.ai/api/auth/z/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: accessToken }),
    });
    if (!resp.ok) {
      throw new Error(`z/login failed: ${resp.status}`);
    }
    const data = await resp.json();
    const token = data.access_token ?? data.accessToken ?? data.data?.access_token;
    // Shape guard: silently returning undefined used to store a bogus
    // credential that surfaced only as cryptic upstream 401s.
    if (typeof token !== "string" || token.length === 0) {
      throw new Error("z/login returned unexpected shape: access_token missing or empty");
    }
    return token;
  }

  async resolveCustomerInfo(
    host: string,
    authorization: string,
  ): Promise<{ orgId: string; projectId: string }> {
    const data = await requestBizApi(
      this.fetchImpl,
      `${host}/api/biz/customer/getCustomerInfo`,
      authorization,
      { method: "GET" },
    );

    const orgs: any[] = data.organizations ?? data.orgs ?? [];
    if (!Array.isArray(orgs) || orgs.length === 0) {
      throw new Error("No organizations found");
    }
    const org = orgs.find((o) =>
      (o.organizationName ?? o.name ?? "").includes(DEFAULT_ORG_MARKER),
    ) ?? orgs[0];
    const orgId = org.organizationId ?? org.id ?? org.orgId;

    const projects: any[] = org.projects ?? [];
    if (!Array.isArray(projects) || projects.length === 0) {
      throw new Error("No projects found in default organization");
    }
    const project = projects.find((p) =>
      (p.projectName ?? p.name ?? "").includes(DEFAULT_PROJECT_MARKER),
    ) ?? projects[0];
    const projectId = project.projectId ?? project.id;

    return { orgId, projectId };
  }

  async findOrCreateApiKey(
    host: string,
    authorization: string,
    orgId: string,
    projectId: string,
  ): Promise<{ apiKey: string }> {
    const listUrl = `${host}/api/biz/v1/organization/${orgId}/projects/${projectId}/api_keys`;

    let existing: any[] = [];
    try {
      existing = await requestBizApi(this.fetchImpl, listUrl, authorization, { method: "GET" }) ?? [];
    } catch { /* ignore — will create */ }

    if (Array.isArray(existing)) {
      const found = existing.find((k: any) => k.name === ZAI_API_KEY_NAME);
      // Reuse the listed key only when it has a usable shape; a malformed
      // entry falls through to the create path instead of poisoning the
      // stored credential.
      if (found && typeof found.apiKey === "string" && found.apiKey.length > 0) {
        return { apiKey: found.apiKey };
      }
    }

    const created = await requestBizApi(this.fetchImpl, listUrl, authorization, {
      method: "POST",
      body: JSON.stringify({ name: ZAI_API_KEY_NAME }),
    });
    // Shape guard (CL-06): an upstream response drift (renamed/nested field)
    // must fail the login with a clear error — not store the string
    // "undefined" and 401 on every later request.
    if (typeof created?.apiKey !== "string" || created.apiKey.length === 0) {
      throw new Error("API key creation returned unexpected shape: apiKey missing or empty");
    }
    return { apiKey: created.apiKey };
  }

  async getSecretKey(
    host: string,
    authorization: string,
    orgId: string,
    projectId: string,
    apiKey: string,
  ): Promise<string> {
    const url = `${host}/api/biz/v1/organization/${orgId}/projects/${projectId}/api_keys/copy/${encodeURIComponent(apiKey)}`;
    const data = await requestBizApi(this.fetchImpl, url, authorization, { method: "GET" });
    return data.secretKey ?? data.secret_key ?? "";
  }

  async resolveCodingPlanCredential(
    accessToken: string,
    provider: ProviderId,
    userId?: string,
    plan: PlanId = "coding-plan",
    email?: string,
  ): Promise<Credential> {
    if (provider === "zai") {
      let bizToken = accessToken;
      try {
        // Fork (from lealll v0.3.x): OAuth responses from zcode.z.ai still
        // carry a raw ZAI access token, but ZCode 3.2.5 stores
        // oauth:zai:access_token after it has already been exchanged through
        // /api/auth/z/login. Tolerate both shapes.
        bizToken = await this.resolveZaiBizToken(accessToken);
      } catch {
        bizToken = accessToken;
      }
      const host = "https://api.z.ai";
      const authorization = `Bearer ${bizToken}`;

      const { orgId, projectId } = await this.resolveCustomerInfo(host, authorization);
      const { apiKey } = await this.findOrCreateApiKey(host, authorization, orgId, projectId);
      // Bundle `dJr` runs with requireSecretKey=true for zai: a missing
      // secretKey fails the login instead of storing a credential that can
      // never sign (3.12.3: "API key copy response is missing secretKey.").
      const secret = await this.getSecretKey(host, authorization, orgId, projectId, apiKey);
      if (!secret) {
        throw new Error("zai API key copy response is missing secretKey");
      }

      const cred: Credential = { apiKey, secret, provider: "zai", plan, userId };
      if (email) cred.email = email;
      // 4.7.2-fork.1: retain the raw OAuth access token — the 3.14.4 desktop
      // reset endpoints require it as `X-Bigmodel-Authorization`.
      cred.maasToken = accessToken;
      return cred;
    }

    const host = "https://bigmodel.cn";
    const authorization = accessToken;

    const { orgId, projectId } = await this.resolveCustomerInfo(host, authorization);
    const { apiKey } = await this.findOrCreateApiKey(host, authorization, orgId, projectId);

    let fullKey = apiKey;
    try {
      const secret = await this.getSecretKey(host, authorization, orgId, projectId, apiKey);
      if (secret) fullKey = `${apiKey}.${secret}`;
    } catch { /* use apiKey only */ }

    const cred: Credential = { apiKey: fullKey, provider: "bigmodel", plan, userId };
    if (email) cred.email = email;
    // 4.7.2-fork.1: bigmodel OAuth token doubles as the MAAS authorization.
    cred.maasToken = accessToken;
    return cred;
  }

  /**
   * Fork multi-account entry point (from lealll v0.3.x): resolve a credential
   * with a start-plan graceful fallback.
   *
   * For **coding-plan**, the biz-API exchange is mandatory — there is no
   * alternative credential, so any failure propagates (throws).
   *
   * For **start-plan**, the actual upstream credential is the ZCode plan JWT
   * (sent as `Authorization: Bearer {jwt}` via zcode.z.ai). The biz-API
   * `apiKey`/`secret` are only decorative for start-plan, so if the biz
   * exchange fails (e.g. the 1-hour access token already expired, or the
   * account has no biz profile), we MUST NOT lose the whole login. Fall back
   * to a start-plan credential whose `apiKey` mirrors the JWT (matching the
   * import path's start-plan shape), so the credential still saves and works.
   */
  async resolveCredential(
    accessToken: string,
    provider: ProviderId,
    userId: string | undefined,
    plan: PlanId,
    jwt?: string,
    email?: string,
  ): Promise<Credential> {
    if (plan !== "start-plan") {
      const cred = await this.resolveCodingPlanCredential(accessToken, provider, userId, plan, email);
      if (jwt) cred.jwt = jwt;
      return cred;
    }

    try {
      const cred = await this.resolveCodingPlanCredential(accessToken, provider, userId, plan, email);
      if (jwt) cred.jwt = jwt;
      return cred;
    } catch (err) {
      if (!jwt) {
        // Nothing to fall back to — propagate so the caller surfaces the error
        // instead of silently storing an empty credential.
        throw err;
      }
      console.warn(
        `[resolver] start-plan biz-API exchange failed (${(err as Error).message}); ` +
        `falling back to JWT-only start-plan credential.`,
      );
      const cred: Credential = {
        apiKey: jwt,
        provider,
        plan: "start-plan",
        jwt,
        userId,
      };
      if (email) cred.email = email;
      cred.maasToken = accessToken;
      return cred;
    }
  }
}
