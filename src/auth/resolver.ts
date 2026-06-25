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
    return data.access_token ?? data.accessToken ?? data.data?.access_token;
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
      if (found?.apiKey) {
        return { apiKey: found.apiKey };
      }
    }

    const created = await requestBizApi(this.fetchImpl, listUrl, authorization, {
      method: "POST",
      body: JSON.stringify({ name: ZAI_API_KEY_NAME }),
    });
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
      const bizToken = await this.resolveZaiBizToken(accessToken);
      const host = "https://api.z.ai";
      const authorization = `Bearer ${bizToken}`;

      const { orgId, projectId } = await this.resolveCustomerInfo(host, authorization);
      const { apiKey } = await this.findOrCreateApiKey(host, authorization, orgId, projectId);
      let secret: string | undefined;
      try {
        secret = await this.getSecretKey(host, authorization, orgId, projectId, apiKey);
      } catch { /* credential will be apiKey-only */ }

      const cred: Credential = { apiKey, secret: secret || undefined, provider: "zai", plan, userId };
      if (email) cred.email = email;
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
    return cred;
  }

  /**
   * Resolve a credential with a start-plan graceful fallback.
   *
   * For **coding-plan**, the biz-API exchange is mandatory — there is no
   * alternative credential, so any failure propagates (throws).
   *
   * For **start-plan**, the actual upstream credential is the ZCode plan JWT
   * (sent as `Authorization: Bearer {jwt}` via zcode.z.ai — see
   * src/proxy/upstream.ts buildAuthHeaders). The biz-API `apiKey`/`secret` are
   * only decorative for start-plan, so if the biz exchange fails (e.g. the
   * 1-hour `zai.access_token` already expired, or the account has no biz
   * profile), we MUST NOT lose the whole login. Instead, fall back to a
   * start-plan credential whose `apiKey` mirrors the JWT (matching
   * importFromZCodeConfig's start-plan shape), so the credential still saves
   * and works.
   *
   * `jwt` is attached to the result whenever present (both paths).
   */
  async resolveCredential(
    accessToken: string,
    provider: ProviderId,
    userId: string | undefined,
    plan: PlanId,
    jwt?: string,
    email?: string,
  ): Promise<Credential> {
    // coding-plan: no fallback — biz API is the only credential source.
    if (plan !== "start-plan") {
      const cred = await this.resolveCodingPlanCredential(accessToken, provider, userId, plan, email);
      if (jwt) cred.jwt = jwt;
      return cred;
    }

    // start-plan: try biz API for the decorative apiKey/secret, but tolerate
    // failure by falling back to a JWT-only credential.
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
      return cred;
    }
  }
}
