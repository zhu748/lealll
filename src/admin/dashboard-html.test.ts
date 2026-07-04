import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

function readDashboardHtml(): string {
  return readFileSync(join(here, "dashboard.html.txt"), "utf8");
}

function inlineScripts(html: string): string[] {
  return [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/gi)].map((m) => m[1]);
}

describe("dashboard HTML inline scripts", () => {
  it("remain syntactically valid", () => {
    const scripts = inlineScripts(readDashboardHtml());
    expect(scripts.length).toBeGreaterThan(0);
    for (const script of scripts) {
      expect(() => new Function(script)).not.toThrow();
    }
  });

  it("uses generation-based OAuth poll cancellation", () => {
    const html = readDashboardHtml();
    expect(html).toContain("let oauthPollGeneration=0");
    expect(html).toContain("function isOAuthPollStale(flowId,generation)");
    expect(html).toContain("function waitForDashboardVisibleOrDelay(maxDelayMs=60000)");
    expect(html).toContain("document.addEventListener('visibilitychange',onVisible);");
    expect(html).toContain("await waitForDashboardVisibleOrDelay(60000);");
    expect(html).toContain("const pollGeneration=++oauthPollGeneration");
    expect(html).toContain("pollOAuth(d.flowId,pollGeneration)");
    expect(html).not.toContain("if(oauthPollCancelled===false)");
  });

  it("debounces large account-table filtering and caps rendered rows", () => {
    const html = readDashboardHtml();
    expect(html).toContain("const ACCOUNT_MAX_RENDERED_ROWS=500");
    expect(html).toContain("oninput=\"scheduleFilterAccounts()\"");
    expect(html).toContain("function scheduleFilterAccounts()");
    expect(html).toContain("for(const account of _cachedAccounts){");
    expect(html).toContain("if(visibleAccounts.length<ACCOUNT_MAX_RENDERED_ROWS)visibleAccounts.push(account);");
    expect(html).toContain("matchedCount>visibleAccounts.length");
  });

  it("keeps account filtering allocation-light on large account stores", () => {
    const html = readDashboardHtml();
    expect(html).toContain("function cacheAccountSearchText(account)");
    expect(html).toContain("Object.defineProperty(account,'_searchText'");
    expect(html).toContain("for(const account of accounts)cacheAccountSearchText(account);");
    expect(html).toContain("if(search&&!(account._searchText||cacheAccountSearchText(account)._searchText).includes(search))continue;");
    expect(html).not.toContain("accounts=accounts.filter");
    expect(html).not.toContain("accounts.filter(a=>");
  });

  it("surfaces disabled state in the active credential card", () => {
    const html = readDashboardHtml();
    expect(html).toContain("<span class=\"kv-key\">状态</span>");
    expect(html).toContain("c.disabled?'<span class=\"badge badge-danger\">已禁用</span>'");
    expect(html).toContain("<span class=\"kv-key\">账号代理</span>");
  });

  it("refreshes active credential summary after toggling disabled state", () => {
    const html = readDashboardHtml();
    expect(html).toContain("toast(`已${action}账号`,'success');");
    expect(html).toContain("refreshAccountViews()");
  });

  it("coalesces account view refreshes and reuses one credential snapshot", () => {
    const html = readDashboardHtml();
    expect(html).toContain("const ACCOUNT_REFRESH_DEBOUNCE_MS=60");
    expect(html).toContain("function refreshAccountViews()");
    expect(html).toContain("if(document.hidden||!dashboardActive())return;");
    expect(html).toContain("let _credentialViewsLoadGeneration=0;");
    expect(html).toContain("let _accountListLoadGeneration=0;");
    expect(html).toContain("loadCredentialViews()");
    expect(html).toContain("Promise.allSettled([\n    loadCredentialViews(),\n    loadAccountsList(),");
    expect(html).toContain("if(_accountViewsRefreshPending&&!document.hidden&&dashboardActive())refreshAccountViews();");
  });

  it("bounds account refresh requests with timeouts and surfaces HTTP failures", () => {
    const html = readDashboardHtml();
    expect(html).toContain("function createDashboardFetchContext(input,init={},timeoutMs=8000)");
    expect(html).toContain("async function fetchJsonWithTimeout(input,init={},timeoutMs=8000)");
    expect(html).toContain("const ctx=createDashboardFetchContext(input,init,timeoutMs);");
    expect(html).toContain("const r=await fetch(input,{...init,signal:ctx.ctrl.signal});");
    expect(html).toContain("d=await r.json();");
    expect(html).toContain("if(r.ok)throw new Error('Invalid JSON response');");
    expect(html).toContain("if(ctx.timedOut)throw dashboardFetchTimeoutError(ctx.timeout);");
    expect(html).toContain("ctx.cleanup();");
    expect(html).toContain("if(!r.ok){");
    expect(html).toContain("throw new Error(msg);");
    expect(html).toContain("return await fetchJsonWithTimeout(API+'/admin/api/credentials',{headers:authHeaders()},5000);");
    expect(html).toContain("const d=await fetchJsonWithTimeout(API+'/admin/api/accounts',{headers:authHeaders()},5000);");
    expect(html).not.toContain("const r=await fetch(API+'/admin/api/accounts',{headers:authHeaders()});");
  });

  it("debounces log search rendering", () => {
    const html = readDashboardHtml();
    expect(html).toContain("const LOG_FILTER_DEBOUNCE_MS=80");
    expect(html).toContain("function scheduleLogFilterRender()");
    expect(html).toContain("if(!dashboardCanUpdate())return;\n    renderLogs();");
    expect(html).toContain("logSearch').addEventListener('input',scheduleLogFilterRender)");
  });

  it("cancels queued log renders on logout, hide, and manual clear", () => {
    const html = readDashboardHtml();
    expect(html).toContain("let _logRenderTimer=null");
    expect(html).toContain("let _logRenderFrame=null");
    expect(html).toContain("function clearLogRenderTimer()");
    expect(html).toContain("if(_logRenderFrame!==null&&typeof cancelAnimationFrame==='function')cancelAnimationFrame(_logRenderFrame);");
    expect(html).toContain("if(_logRenderTimer!==null)clearTimeout(_logRenderTimer);");
    expect(html).toContain("if(!dashboardCanUpdate())return;\n      renderLogs();");
    expect(html).toContain("clearAccountViewsRefreshTimer();\n  clearLogRenderTimer();\n  clearLogFilterTimer();");
    expect(html).toContain("clearAccountFilterTimer();\n    clearLogRenderTimer();\n    clearLogFilterTimer();\n    abortDashboardRequests();");
    expect(html).toContain("function clearLogs(){clearLogRenderTimer();clearLogFilterTimer();logLines=[];expandedLogSeqs.clear();");
  });

  it("caps visible toasts and reuses one dismiss path", () => {
    const html = readDashboardHtml();
    expect(html).toContain("const TOAST_MAX_VISIBLE=5");
    expect(html).toContain("function dismissToast(el)");
    expect(html).toContain("while(container.children.length>=TOAST_MAX_VISIBLE){");
    expect(html).toContain("if(first._toastTimer){clearTimeout(first._toastTimer);first._toastTimer=null;}");
    expect(html).toContain("el.addEventListener('click',()=>dismissToast(el));");
    expect(html).toContain("el._toastTimer=setTimeout(()=>dismissToast(el),3000);");
    expect(html).not.toContain("setTimeout(()=>el.remove(),200);\n  });\n  container.appendChild(el);");
  });

  it("keeps log filtering allocation-light on long-running dashboards", () => {
    const html = readDashboardHtml();
    expect(html).toContain("entry._searchText=(entry.message||'').toLowerCase();");
    expect(html).toContain("for(let i=logLines.length-1;i>=0;i--){");
    expect(html).toContain("if(visible.length<MAX_RENDERED_LOGS)visible.push(l);");
    expect(html).toContain("visible.reverse();");
    expect(html).not.toContain("const filtered=logLines.filter");
    expect(html).not.toContain("visible=filtered.slice(-MAX_RENDERED_LOGS)");
  });

  it("coalesces repeated config loads and invalidates after config writes", () => {
    const html = readDashboardHtml();
    expect(html).toContain("const CONFIG_CACHE_TTL_MS=1000");
    expect(html).toContain("let _configSnapshotInFlight=null");
    expect(html).toContain("let _configSnapshotInFlightKey=''");
    expect(html).toContain("let _configSnapshotGeneration=0");
    expect(html).toContain("function applyConfigSnapshotCache(config)");
    expect(html).toContain("function invalidateConfigSnapshot(){\n  _configSnapshotGeneration++;");
    expect(html).toContain("async function fetchConfigSnapshot(options={})");
    expect(html).toContain("const request=fetchJsonWithTimeout(API+'/admin/api/config',{headers:authHeaders()},5000)");
    expect(html).toContain("const requestAuthToken=authToken;");
    expect(html).toContain("const requestInitGeneration=dashboardInitGeneration;");
    expect(html).toContain("const requestConfigGeneration=_configSnapshotGeneration;");
    expect(html).toContain("const requestKey=requestConfigGeneration+'|'+requestInitGeneration+'|'+requestAuthToken;");
    expect(html).toContain("if(force||!_configSnapshotInFlight||_configSnapshotInFlightKey!==requestKey){");
    expect(html).toContain("if(requestConfigGeneration!==_configSnapshotGeneration||requestAuthToken!==authToken||requestInitGeneration!==dashboardInitGeneration)return c;");
    expect(html).toContain("return applyConfigSnapshotCache(c);");
    expect(html).toContain("if(_configSnapshotInFlight===request){_configSnapshotInFlight=null;_configSnapshotInFlightKey='';}");
    expect(html).toContain("_configSnapshotInFlightKey=requestKey;");
    expect(html).toContain("const c=await fetchConfigSnapshot();");
    expect(html).toContain("async function loadSettings(force=false)");
    expect(html).toContain("const cfg=await fetchConfigSnapshot({force:true});");
    expect(html).toContain("invalidateConfigSnapshot();\n    toast('端点已保存','success');");
  });

  it("bounds first-paint overview requests with timeouts", () => {
    const html = readDashboardHtml();
    expect(html).toContain("const request=fetchJsonWithTimeout(API+'/admin/api/config',{headers:authHeaders()},5000)");
    expect(html).toContain("const health=await fetchWithTimeout(API+'/health',{headers:authHeaders()},3000);");
    expect(html).not.toContain("const health=await fetch(API+'/health',{headers:authHeaders()});");
  });

  it("aborts in-flight dashboard fetches on logout, hide, and unload", () => {
    const html = readDashboardHtml();
    expect(html).toContain("let dashboardAbortController=new AbortController()");
    expect(html).toContain("function resetDashboardAbortController()");
    expect(html).toContain("function abortDashboardRequests()");
    expect(html).toContain("function dashboardAbortApplies(input,init)");
    expect(html).toContain("return method==='GET'||method==='HEAD'||method==='OPTIONS';");
    expect(html).toContain("let timedOut=false;");
    expect(html).toContain("timedOut=true;\n    ctrl.abort();");
    expect(html).toContain("const dashboardSignal=dashboardAbortApplies(input,init)?resetDashboardAbortController().signal:null;");
    expect(html).toContain("const linkedSignals=[];");
    expect(html).toContain("linkSignal(upstreamSignal);");
    expect(html).toContain("if(dashboardSignal&&dashboardSignal!==upstreamSignal)linkSignal(dashboardSignal);");
    expect(html).toContain("for(const signal of linkedSignals)signal.removeEventListener('abort',onAbort);");
    expect(html).toContain("return {ctrl,timeout,cleanup,get timedOut(){return timedOut;}};");
    expect(html).toContain("function dashboardFetchTimeoutError(timeout)");
    expect(html).toContain("dashboardInitGeneration++;\n  abortDashboardRequests();\n  authToken='';");
    expect(html).toContain("clearAccountFilterTimer();\n    clearLogRenderTimer();\n    clearLogFilterTimer();\n    abortDashboardRequests();");
    expect(html).toContain("window.addEventListener('pagehide',abortDashboardRequests);");
  });

  it("keeps model-mapping datalist in sync after settings saves", () => {
    const html = readDashboardHtml();
    expect(html).toContain("function syncConfigModelsForUi(models)");
    expect(html).toContain("window.__config={...(window.__config||{}),models:[...models]};");
    expect(html).toContain("syncConfigModelsForUi(cfg.models);");
    expect(html).toContain("renderModelMappings();");
    expect(html).toContain("const whitelist=window.__config&&Array.isArray(window.__config.models)?window.__config.models:[];");
  });

  it("keeps Responses thinking custom input limited to non-catalog models", () => {
    const html = readDashboardHtml();
    expect(html).toContain("function responsesThinkingCatalogIdSet()");
    expect(html).toContain("function syncResponsesThinkingCustomInput(models)");
    expect(html).toContain("renderResponsesThinkingChips();\n    syncResponsesThinkingCustomInput();");
    expect(html).toContain("renderResponsesThinkingChips();\n    syncResponsesThinkingCustomInput(d.models||[]);");
    expect(html).toContain("const catalogIds=responsesThinkingCatalogIdSet();\n  const customStr=");
    expect(html).toContain("if(id&&!catalogIds.has(key))selected.add(key);");
    expect(html).toContain("syncResponsesThinkingCustomInput(serverModels);");
  });

  it("prevents stale stats responses from overwriting reset stats", () => {
    const html = readDashboardHtml();
    expect(html).toContain("let statsLoadPending=false");
    expect(html).toContain("let statsLoadGeneration=0");
    expect(html).toContain("function invalidateStatsLoads()");
    expect(html).toContain("if(statsLoadInFlight){statsLoadPending=true;return;}");
    expect(html).toContain("statsLoadPending=false;\n  const generation=statsLoadGeneration;");
    expect(html).toContain("const d=await fetchJsonWithTimeout(API+'/admin/api/stats',{headers:authHeaders()},5000);");
    expect(html).not.toContain("const r=await fetchWithTimeout(API+'/admin/api/stats',{headers:authHeaders()},5000);");
    expect(html).toContain("if(generation!==statsLoadGeneration||document.hidden||!dashboardActionCurrent(requestInitGeneration,requestAuthToken))return;");
    expect(html).toContain("if(!beginExclusiveAction('statsReset','统计重置正在进行中，请稍候'))return;");
    expect(html).toContain("if(!dashboardActionCurrent(requestInitGeneration,requestAuthToken))return;");
    expect(html).toContain("endExclusiveAction('statsReset');");
    expect(html).toContain("await fetchJsonMutationWithTimeout(API+'/admin/api/stats',{method:'DELETE',headers:authHeaders()});");
    expect(html).toContain("invalidateStatsLoads();\n    loadStats();");
  });

  it("keeps dashboard polling and log SSE paused while the tab is hidden", () => {
    const html = readDashboardHtml();
    expect(html).toContain("if(document.hidden||!dashboardActive())return;");
    expect(html).toContain("if(logEventSource!==source||document.hidden||!dashboardActive())return;");
    expect(html).toContain("if(logEventSource!==source)return;");
    expect(html).toContain("if(document.hidden||!dashboardActive()||logReconnectTimer)return;");
    expect(html).toContain("if(!document.hidden&&dashboardActive())connectLogStream();");
    expect(html).toContain("if(document.hidden||!dashboardActive()){statsIntervalId=null;return;}");
    expect(html).toContain("function dashboardCanUpdate(){return !document.hidden&&dashboardActive()}");
    expect(html).toContain("uptimeIntervalId=(dashboardCanUpdate()&&dashboardActionCurrent(requestInitGeneration,requestAuthToken))?setInterval(tickUptimeDisplay,1000):null;");
    expect(html).toContain("statsIntervalId=setInterval(()=>{if(dashboardCanUpdate())loadStats()},10000);");
    expect(html).toContain("if(generation!==statsLoadGeneration||document.hidden||!dashboardActionCurrent(requestInitGeneration,requestAuthToken))return;");
    expect(html).toContain("if(generation!==ppPoolLoadGeneration||document.hidden||!dashboardActionCurrent(requestInitGeneration,requestAuthToken))return;");
    expect(html).toContain("if(dashboardCanUpdate()&&ppTestPollErrorCount<3)");
    expect(html).toContain("ppTestPollTimer=setTimeout(async()=>{\n    ppTestPollTimer=null;");
    expect(html).toContain("const state=await fetchJsonWithTimeout(API+'/admin/api/proxy-pool/test-status?sinceSeq='+encodeURIComponent(ppTestJobSeq),{headers:authHeaders()},5000);");
    expect(html).toContain("const state=await fetchJsonWithTimeout(API+'/admin/api/proxy-pool/test-status',{headers:authHeaders()},5000);");
    expect(html).toContain("clearProxyPoolProgressHideTimer();");
    expect(html).toContain("clearAccountViewsRefreshTimer();");
    expect(html).toContain("if(accountsPage&&accountsPage.classList.contains('active')){\n        refreshAccountViews();\n      }");
  });

  it("cancels stale dashboard initialization after logout", () => {
    const html = readDashboardHtml();
    expect(html).toContain("let dashboardInitGeneration=0");
    expect(html).toContain("dashboardInitGeneration++;\n  abortDashboardRequests();\n  authToken='';");
    expect(html).toContain("const initGeneration=++dashboardInitGeneration;");
    expect(html).toContain("if(initGeneration!==dashboardInitGeneration||!dashboardActive())return;");
    expect(html).toContain("banner.id='noAuthWarningBanner';");
  });

  it("guards async dashboard loaders from stale DOM writes", () => {
    const html = readDashboardHtml();
    expect(html).toContain("async function loadOverview(){\n  const requestAuthToken=authToken;\n  const requestInitGeneration=dashboardInitGeneration;");
    expect(html).toContain("const c=await fetchConfigSnapshot();\n    if(!dashboardCanUpdate()||!dashboardActionCurrent(requestInitGeneration,requestAuthToken))return;\n    document.getElementById('statProvider')");
    expect(html).toContain("const generation=++_credentialViewsLoadGeneration;\n  const requestAuthToken=authToken;");
    expect(html).toContain("if(generation!==_credentialViewsLoadGeneration||!dashboardCanUpdate()||!dashboardActionCurrent(requestInitGeneration,requestAuthToken))return;");
    expect(html).toContain("const generation=++_accountListLoadGeneration;\n  const requestAuthToken=authToken;");
    expect(html).toContain("if(generation!==_accountListLoadGeneration||!dashboardCanUpdate()||!dashboardActionCurrent(requestInitGeneration,requestAuthToken))return;");
    expect(html).toContain("const d=await fetchJsonWithTimeout(API+'/admin/api/routing-rules',{headers:authHeaders()},5000);");
    expect(html).toContain("if(!dashboardCanUpdate()||!dashboardActionCurrent(requestInitGeneration,requestAuthToken))return;\n    routingRules=(d.rules||[])");
    expect(html).toContain("const d=await fetchJsonWithTimeout(API+'/admin/api/model-mappings',{headers:authHeaders()},5000);");
    expect(html).toContain("const d=await fetchJsonWithTimeout(API+'/admin/api/glm-models',{headers:authHeaders()},5000);");
    expect(html).toContain("if(!dashboardCanUpdate()||!dashboardActionCurrent(requestInitGeneration,requestAuthToken))return;\n    glmCatalog=Array.isArray(d.models)?d.models:[];");
    expect(html).toContain("const d=await fetchJsonWithTimeout(API+'/admin/api/responses-thinking',{headers:authHeaders()},5000);");
    expect(html).toContain("if(!dashboardCanUpdate()||!dashboardActionCurrent(requestInitGeneration,requestAuthToken))return;\n    responsesThinkingModels=new Set");
    expect(html).toContain("if(!dashboardCanUpdate()||!dashboardActionCurrent(requestInitGeneration,requestAuthToken))return;\n    const dumps=d.dumps||[];");
    expect(html).toContain("if(!dashboardCanUpdate()||!dashboardActionCurrent(requestInitGeneration,requestAuthToken))return;\n    if(state.running){");
  });

  it("clears OAuth countdown timers without leaving stale handles", () => {
    const html = readDashboardHtml();
    expect(html).toContain("function clearOauthExpiryTimer()");
    expect(html).toContain("if(oauthExpiryTimer){clearInterval(oauthExpiryTimer);oauthExpiryTimer=null}");
    expect(html).toContain("clearOauthExpiryTimer();\n  document.getElementById('app').classList.remove('show');");
  });

  it("coalesces proxy-pool loads and ignores stale responses after mutations", () => {
    const html = readDashboardHtml();
    expect(html).toContain("let ppPoolLoadInFlight=false");
    expect(html).toContain("let ppPoolLoadPending=false");
    expect(html).toContain("let ppPoolLoadPendingForceConfig=false");
    expect(html).toContain("let ppPoolLoadGeneration=0");
    expect(html).toContain("let ppSingleTestGeneration=0");
    expect(html).toContain("let ppLastPrunedProxiesRef=null");
    expect(html).toContain("function invalidateProxyPoolLoads()");
    expect(html).toContain("ppPoolLoadPendingForceConfig=false;");
    expect(html).toContain("ppLastPrunedProxiesRef=null;");
    expect(html).toContain("ppSingleTestGeneration++;");
    expect(html).toContain("let ppProgressHideTimer=null;");
    expect(html).toContain("function clearProxyPoolProgressHideTimer()");
    expect(html).toContain("function pruneProxyPoolTestResults(proxies)");
    expect(html).toContain("if(ppLastPrunedProxiesRef===proxies)return;");
    expect(html).toContain("ppLastPrunedProxiesRef=proxies;");
    expect(html).toContain("if(!liveIds.has(id))delete ppTestResults[id];");
    expect(html).toContain("pruneProxyPoolTestResults(proxies);");
    expect(html).toContain("if(ppPoolLoadInFlight){\n    ppPoolLoadPending=true;\n    if(options.forceConfig===true)ppPoolLoadPendingForceConfig=true;\n    return;\n  }");
    expect(html).toContain("ppPoolLoadPending=false;\n  ppPoolLoadPendingForceConfig=false;\n  const generation=ppPoolLoadGeneration;");
    expect(html).toContain("const state=await fetchJsonWithTimeout(API+'/admin/api/proxy-pool',{headers:authHeaders()},5000);");
    expect(html).toContain("if(generation!==ppPoolLoadGeneration||document.hidden||!dashboardActionCurrent(requestInitGeneration,requestAuthToken))return;");
    expect(html).toContain("const pendingForceConfig=ppPoolLoadPendingForceConfig;\n      ppPoolLoadPending=false;\n      ppPoolLoadPendingForceConfig=false;\n      loadProxyPool({forceConfig:pendingForceConfig});");
    expect(html).toContain("invalidateProxyPoolLoads();\n    await loadProxyPool();");
    expect(html).toContain("clearProxyPoolPollTimer();\n  clearProxyPoolProgressHideTimer();");
    expect(html).toContain("invalidateProxyPoolLoads();\n    await loadProxyPool();");
  });

  it("does not overwrite dirty proxy-pool config inputs during polling", () => {
    const html = readDashboardHtml();
    expect(html).toContain("let ppConfigLastSyncedKey=''");
    expect(html).toContain("let ppConfigDirty=false");
    expect(html).toContain("const PP_CONFIG_INPUT_IDS=['ppEnabled','ppRefreshInterval','ppMaxRotations','ppRotateOnGatewayBlock','ppSourceUrls'];");
    expect(html).toContain("function initProxyPoolConfigDirtyTracking()");
    expect(html).toContain("el.addEventListener('input',markProxyPoolConfigDirty);");
    expect(html).toContain("el.addEventListener('change',markProxyPoolConfigDirty);");
    expect(html).toContain("function syncProxyPoolConfigForm(config,options={})");
    expect(html).toContain("const canOverwrite=options.force===true||!ppConfigDirty||currentKey===ppConfigLastSyncedKey||currentKey===serverKey;");
    expect(html).toContain("syncProxyPoolConfigForm(c,{force:options.forceConfig===true});");
    expect(html).toContain("function reloadProxyPool(){\n  ppConfigDirty=false;\n  loadProxyPool({forceConfig:true});\n}");
    expect(html).toContain("onclick=\"reloadProxyPool()\"");
    expect(html).toContain("initProxyPoolConfigDirtyTracking();");
    expect(html).not.toContain("document.getElementById('ppSourceUrls').value=(c.sourceUrls||[]).join('\\n');\n\n  const proxies=ppPoolState.proxies||[];");
  });

  it("rejects invalid retry status tokens before saving settings", () => {
    const html = readDashboardHtml();
    expect(html).toContain("const statusTokens=statusesRaw.split(',').map(s=>s.trim()).filter(Boolean);");
    expect(html).toContain("let invalidStatusToken='';");
    expect(html).toContain("const n=/^\\d+$/.test(token)?Number(token):NaN;");
    expect(html).toContain("if(!Number.isInteger(n)||n<100||n>599){invalidStatusToken=token;break}");
    expect(html).toContain("if((statusesRaw.trim()&&statusTokens.length===0)||invalidStatusToken){");
    expect(html).not.toContain(".map(s=>parseInt(s,10))\n    .filter(n=>Number.isFinite(n)&&n>=100&&n<=599)");
  });

  it("rejects invalid settings numeric inputs before saving", () => {
    const html = readDashboardHtml();
    expect(html).toContain("function readSettingsNumberInput(id,label,opts={})");
    expect(html).toContain("const n=/^[+-]?\\d+(?:\\.\\d+)?$/.test(raw)?Number(raw):NaN;");
    expect(html).toContain("const port=readSettingsNumberInput('cfgPort','监听端口',{min:1,max:65535});");
    expect(html).toContain("const maxBody=readSettingsNumberInput('cfgMaxBody','最大请求体',{min:0});");
    expect(html).toContain("const maxRetries=readSettingsNumberInput('cfgRetryMax','最大重试次数',{min:0});");
    expect(html).toContain("<input id=\"cfgRetryDelay\" type=\"number\" min=\"1\" max=\"60000\" step=\"1\">");
    expect(html).toContain("<input id=\"cfgRetryMaxDelay\" type=\"number\" min=\"1\" max=\"300000\" step=\"1\">");
    expect(html).toContain("const initialDelayMs=readSettingsNumberInput('cfgRetryDelay','初始延迟',{min:1,max:60000});");
    expect(html).toContain("const maxDelayMs=readSettingsNumberInput('cfgRetryMaxDelay','最大延迟',{min:1,max:300000});");
    expect(html).toContain("const backoffFactor=readSettingsNumberInput('cfgRetryBackoff','退避因子',{integer:false,greaterThan:0});");
    expect(html).toContain("if(port===null||maxBody===null||maxRetries===null||initialDelayMs===null||maxDelayMs===null||backoffFactor===null||credSwitch===null||emptyStreamSwitch===null){");
    expect(html).toContain("server:{port,host:document.getElementById('cfgHost').value,maxRequestBodyBytes:maxBody}");
    expect(html).toContain("maxRetries,\n      initialDelayMs,\n      maxDelayMs,\n      backoffFactor,");
    expect(html).not.toContain("const maxRetries=parseInt(document.getElementById('cfgRetryMax').value,10);");
    expect(html).not.toContain("const backoffFactor=parseFloat(document.getElementById('cfgRetryBackoff').value);");
    expect(html).not.toContain("maxRetries:Number.isFinite(maxRetries)?maxRetries:3");
    expect(html).not.toContain("maxRequestBodyBytes:Number.isFinite(maxBody)&&maxBody>=0?maxBody:67108864");
  });

  it("rejects invalid proxy-pool numeric inputs before saving", () => {
    const html = readDashboardHtml();
    expect(html).toContain("function readProxyPoolNonNegativeIntInput(id,label,max,showErrors=true)");
    expect(html).toContain("const n=/^\\d+$/.test(raw)?Number(raw):NaN;");
    expect(html).toContain("if(!Number.isSafeInteger(n)){");
    expect(html).toContain("if(n>max){");
    expect(html).toContain("const refreshIntervalMin=readProxyPoolNonNegativeIntInput('ppRefreshInterval','自动更新间隔',1440,showErrors);");
    expect(html).toContain("const maxRotations=readProxyPoolNonNegativeIntInput('ppMaxRotations','最大轮询次数',20,showErrors);");
    expect(html).toContain("if(!config)return;\n  if(!beginExclusiveAction('proxyPoolConfigSave','代理池配置保存正在进行中，请稍候'))return;");
    expect(html).toContain("function readProxyPoolBatchSizeInput()");
    expect(html).toContain("toast('批量并发数必须是 1-50 的整数','error');");
    expect(html).toContain("const batchSize=readProxyPoolBatchSizeInput();\n  if(batchSize===null)return;");
    expect(html).not.toContain("refreshIntervalMin:parseInt(document.getElementById('ppRefreshInterval').value,10)||0");
    expect(html).not.toContain("maxRotations:parseInt(document.getElementById('ppMaxRotations').value,10)||0");
    expect(html).not.toContain("parseInt(document.getElementById('ppBatchSize').value,10)||5");
  });

  it("uses HTML-attribute-safe JS argument escaping for generated action buttons", () => {
    const html = readDashboardHtml();
    expect(html).toContain("function escapeJsAttrString(s){return escapeHtml(escapeJsString(s))}");
    expect(html).toContain("onclick=\"openAccountDetail('${escapeJsAttrString(a.id)}')\"");
    expect(html).toContain("onclick=\"toggleResponsesThinking('${escapeJsAttrString(m.id)}')\"");
    expect(html).toContain("onclick=\"viewDebugDump('${escapeJsAttrString(d.id)}')\"");
    expect(html).toContain("onclick=\"testOneProxy('${escapeJsAttrString(p.id)}')\"");
    expect(html).toContain("onclick=\"removeProxyPoolEntry('${escapeJsAttrString(p.id)}')\"");
    expect(html).not.toContain("onclick=\"testOneProxy('${escapeHtml(p.id)}')");
    expect(html).not.toContain("onclick=\"removeProxyPoolEntry('${escapeHtml(p.id)}')");
  });

  it("guards proxy-pool test actions from stale UI writes", () => {
    const html = readDashboardHtml();
    expect(html).toContain("const generation=ppSingleTestGeneration;\n  const requestAuthToken=authToken;");
    expect(html).toContain("if(generation!==ppSingleTestGeneration||requestAuthToken!==authToken||!dashboardCanUpdate()){");
    expect(html).toContain("if(ppTestResults[id]==='testing')delete ppTestResults[id];");
    expect(html).toContain("const requestInitGeneration=dashboardInitGeneration;\n  const requestAuthToken=authToken;");
    expect(html).toContain("if(requestInitGeneration!==dashboardInitGeneration||requestAuthToken!==authToken||!dashboardCanUpdate())return;");
    expect(html).toContain("ppProgressHideTimer=setTimeout(()=>{\n          ppProgressHideTimer=null;");
    expect(html).toContain("if(requestInitGeneration===dashboardInitGeneration&&requestAuthToken===authToken&&dashboardCanUpdate()){\n            progress.style.display='none';");
    expect(html).toContain("if(requestInitGeneration!==dashboardInitGeneration||requestAuthToken!==authToken||!dashboardCanUpdate())return;\n      console.error('pollTestJob failed:',e);");
  });

  it("guards account detail, quota, and proxy modals from stale async writes", () => {
    const html = readDashboardHtml();
    expect(html).toContain("function dashboardActionCurrent(initGeneration,token){return initGeneration===dashboardInitGeneration&&token===authToken&&dashboardActive()}");
    expect(html).toContain("let accountDetailModalGeneration=0;");
    expect(html).toContain("const generation=++accountDetailModalGeneration;\n  const requestAuthToken=authToken;");
    expect(html).toContain("if(generation!==accountDetailModalGeneration||!dashboardActionCurrent(requestInitGeneration,requestAuthToken))return;");
    expect(html).toContain("if(containerId==='accountDetailModal')accountDetailModalGeneration++;");
    expect(html).toContain("let quotaModalGeneration=0;");
    expect(html).toContain("const generation=++quotaModalGeneration;\n  const requestAuthToken=authToken;");
    expect(html).toContain("const d=await fetchJsonMutationWithTimeout(API+'/admin/api/accounts/quota',{method:'POST',headers:authHeaders(),body:JSON.stringify({id})},15000);");
    expect(html).toContain("if(generation!==quotaModalGeneration||!dashboardActionCurrent(requestInitGeneration,requestAuthToken))return;");
    expect(html).toContain("function closeQuotaModal(){\n  quotaModalGeneration++;");
    expect(html).toContain("let proxyModalGeneration=0;");
    expect(html).toContain("function openProxyModal(id,currentProxy,provider){\n  proxyModalGeneration++;");
    expect(html).toContain("function closeProxyModal(){\n  proxyModalGeneration++;");
    expect(html).toContain("const stillCurrent=()=>generation===proxyModalGeneration");
    expect(html).toContain("&& proxyModalAccountId===requestAccountId");
    expect(html).toContain("const d=await fetchJsonMutationWithTimeout(API+'/admin/api/accounts/proxy-test',{");
    expect(html).toContain("},15000);");
    expect(html).toContain("const d=await fetchJsonMutationWithTimeout(API+'/admin/api/accounts/proxy',{");
    expect(html).toContain("if(generation!==proxyModalGeneration||!dashboardActionCurrent(requestInitGeneration,requestAuthToken))return;");
  });

  it("bounds account row actions and OAuth requests with timeouts", () => {
    const html = readDashboardHtml();
    expect(html).toContain("await fetchJsonMutationWithTimeout(API+'/admin/api/credentials',{method:'POST',headers:authHeaders(),body:JSON.stringify({provider,apiKey:key,plan})});");
    expect(html).toContain("const d=await fetchJsonWithTimeout(API+'/admin/api/import/detect',{headers:authHeaders()},5000);");
    expect(html).toContain("const d=await fetchJsonMutationWithTimeout(API+'/admin/api/import',{method:'POST',headers:authHeaders(),body:JSON.stringify({provider,plan})});");
    expect(html).toContain("await fetchJsonMutationWithTimeout(API+'/admin/api/accounts/active',{method:'PUT',headers:authHeaders(),body:JSON.stringify({id})});");
    expect(html).toContain("await fetchJsonMutationWithTimeout(API+'/admin/api/accounts/label',{method:'PUT',headers:authHeaders(),body:JSON.stringify({id,label})});");
    expect(html).toContain("await fetchJsonMutationWithTimeout(API+'/admin/api/accounts/'+id,{method:'DELETE',headers:authHeaders()});");
    expect(html).toContain("await fetchJsonMutationWithTimeout(API+'/admin/api/accounts/plan',{method:'PUT',headers:authHeaders(),body:JSON.stringify({id,plan})});");
    expect(html).toContain("await fetchJsonMutationWithTimeout(API+'/admin/api/accounts/edit',{method:'PUT',headers:authHeaders(),body:JSON.stringify({id,name,email})});");
    expect(html).toContain("await fetchJsonMutationWithTimeout(API+'/admin/api/accounts/disabled',{method:'PUT',headers:authHeaders(),body:JSON.stringify({id,disabled})});");
    expect(html).toContain("const d=await fetchJsonMutationWithTimeout(API+'/admin/api/oauth/init',{method:'POST',headers:authHeaders(),body:JSON.stringify({provider,plan})},15000);");
    expect(html).toContain("const d=await fetchJsonWithTimeout(API+'/admin/api/oauth/poll?flowId='+flowId,{headers:authHeaders()},8000);");
    expect(html).toContain("const d=await fetchJsonMutationWithTimeout(API+'/admin/api/oauth/callback',{");
    expect(html).toContain("await fetchJsonMutationWithTimeout(API+'/admin/api/credentials',{method:'DELETE',headers:authHeaders()});");
  });

  it("bounds login, stats, and account export requests with timeouts", () => {
    const html = readDashboardHtml();
    expect(html).toContain("await fetchJsonWithTimeout(API+'/admin/api/verify',{headers:{'Authorization':'Bearer '+key}},5000);");
    expect(html).toContain("try{d=await fetchJsonWithTimeout(API+'/admin/api/verify',{},5000)}catch{}");
    expect(html).toContain("await fetchJsonWithTimeout(API+'/admin/api/verify',{headers:{'Authorization':'Bearer '+saved}},5000);");
    expect(html).toContain("const savedSession=sessionStorage.getItem('zcodeProxyAuth');");
    expect(html).toContain("const savedLocal=localStorage.getItem('zcodeProxyAuth');");
    expect(html).toContain("const saved=savedSession||savedLocal;");
    expect(html).toContain("try{sessionStorage.setItem('zcodeProxyAuth',saved)}catch{}");
    expect(html).toContain("if(savedLocal){try{localStorage.removeItem('zcodeProxyAuth')}catch{}}");
    expect(html).toContain("const d=await fetchJsonWithTimeout(API+'/admin/api/stats',{headers:authHeaders()},5000);");
    expect(html).toContain("const d=await fetchJsonWithTimeout(API+'/admin/api/accounts/export-single?id='+encodeURIComponent(id),{headers:authHeaders()},10000);");
    expect(html).toContain("const d=await fetchJsonWithTimeout(API+'/admin/api/accounts/export',{headers:authHeaders()},10000);");
    expect(html).toContain("const d=await fetchJsonWithTimeout(API+'/admin/api/accounts/render-export',{headers:authHeaders()},10000);");
  });

  it("restores the proxy-test button without losing its icon markup", () => {
    const html = readDashboardHtml();
    expect(html).toContain("if(testBtn&&testBtn.dataset.idleHtml)testBtn.innerHTML=testBtn.dataset.idleHtml;");
    expect(html).toContain("if(!btn.dataset.idleHtml)btn.dataset.idleHtml=btn.innerHTML;");
    expect(html).toContain("const originalHtml=btn.dataset.idleHtml;");
    expect(html).toContain("btn.innerHTML='测试中…';");
    expect(html).toContain("btn.innerHTML=originalHtml;");
    expect(html).not.toContain("btn.textContent='测试中…';");
  });

  it("guards debug dump detail views from stale responses and clears", () => {
    const html = readDashboardHtml();
    expect(html).toContain("onclick=\"hideDebugDetail()\"");
    expect(html).toContain("let debugDetailGeneration=0;");
    expect(html).toContain("function hideDebugDetail(){\n  debugDetailGeneration++;");
    expect(html).toContain("hideDebugDetail();\n      tb.innerHTML='<tr><td colspan=\"6\"");
    expect(html).toContain("const generation=++debugDetailGeneration;\n  const requestAuthToken=authToken;");
    expect(html).toContain("document.getElementById('debugDetailMeta').innerHTML='<span class=\"kv-key\">状态</span><span class=\"kv-val\"><span class=\"badge badge-info\">加载中...</span></span>';");
    expect(html).toContain("if(generation!==debugDetailGeneration||!dashboardActionCurrent(requestInitGeneration,requestAuthToken))return;");
    expect(html).toContain("if(!document.hidden)document.getElementById('debugDetailCard').scrollIntoView");
    expect(html).toContain("debugDetailGeneration++;\n  const requestAuthToken=authToken;");
    expect(html).toContain("const d=await fetchJsonWithTimeout(API+'/admin/api/debug-dumps?limit=20',{headers:authHeaders()},5000);");
    expect(html).toContain("const d=await fetchJsonWithTimeout(API+'/admin/api/debug-dumps?id='+encodeURIComponent(id)+'&full=1',{headers:authHeaders()},5000);");
    expect(html).toContain("await fetchJsonMutationWithTimeout(API+'/admin/api/debug-dumps',{method:'DELETE',headers:authHeaders()});");
    expect(html).toContain("if(!dashboardActionCurrent(requestInitGeneration,requestAuthToken))return;");
    expect(html).toContain("toast('已清空','success');loadDebugDumps();hideDebugDetail();");
  });

  it("coalesces captcha helper status loads and ignores stale action responses", () => {
    const html = readDashboardHtml();
    expect(html).toContain("let captchaHelperLoadInFlight=false");
    expect(html).toContain("let captchaHelperLoadPending=false");
    expect(html).toContain("let captchaHelperGeneration=0");
    expect(html).toContain("function invalidateCaptchaHelperLoads()");
    expect(html).toContain("if(captchaHelperLoadInFlight){captchaHelperLoadPending=true;return;}");
    expect(html).toContain("captchaHelperLoadPending=false;\n  const generation=captchaHelperGeneration;");
    expect(html).toContain("const generation=captchaHelperGeneration;\n  const requestAuthToken=authToken;\n  const requestInitGeneration=dashboardInitGeneration;");
    expect(html).toContain("if(generation!==captchaHelperGeneration||document.hidden||!dashboardActionCurrent(requestInitGeneration,requestAuthToken))return;");
    expect(html).toContain("if(!beginExclusiveAction('captchaHelperAction','验证码助手操作正在进行中，请稍候'))return;");
    expect(html).toContain("finally{\n    endExclusiveAction('captchaHelperAction');\n  }");
    expect(html).toContain("invalidateCaptchaHelperLoads();");
  });

  it("guards config-like saves from duplicate submits and stale overwrites", () => {
    const html = readDashboardHtml();
    expect(html).toContain("const MUTATION_TIMEOUT_MS=10000");
    expect(html).toContain("const LONG_MUTATION_TIMEOUT_MS=60000");
    expect(html).toContain("async function fetchJsonMutationWithTimeout(input,init={},timeoutMs=MUTATION_TIMEOUT_MS)");
    expect(html).toContain("if(!beginExclusiveAction('settingsSave','设置保存正在进行中，请稍候'))return;");
    expect(html).toContain("const d=await fetchJsonMutationWithTimeout(API+'/admin/api/config',{method:'PUT',headers:authHeaders(),body:JSON.stringify(cfg)});");
    expect(html).toContain("if(!beginExclusiveAction('proxyEndpointsSave','端点保存正在进行中，请稍候'))return;");
    expect(html).toContain("await fetchJsonMutationWithTimeout(API+'/admin/api/endpoints',{method:'PUT',headers:authHeaders(),body:JSON.stringify(endpoints)});");
    expect(html).toContain("if(!beginExclusiveAction('routingRulesSave','路由规则保存正在进行中，请稍候'))return;");
    expect(html).toContain("const d=await fetchJsonMutationWithTimeout(API+'/admin/api/routing-rules',{method:'PUT',headers:authHeaders(),body:JSON.stringify({rules:rulesForSave})});");
    expect(html).toContain("const rulesForSave=routingRules.map");
    expect(html).toContain("const currentState=JSON.stringify(routingRules.map");
    expect(html).toContain("toast('路由规则已保存；页面上还有新的未保存修改','warn');");
    expect(html).toContain("if(!beginExclusiveAction('modelMappingsSave','模型映射保存正在进行中，请稍候'))return;");
    expect(html).toContain("const d=await fetchJsonMutationWithTimeout(API+'/admin/api/model-mappings',{method:'PUT',headers:authHeaders(),body:JSON.stringify({mappings:mappingsForSave})});");
    expect(html).toContain("const mappingsForSave=modelMappings.map");
    expect(html).toContain("const currentState=JSON.stringify(modelMappings.map");
    expect(html).toContain("toast('模型映射已保存；页面上还有新的未保存修改','warn');");
    expect(html).toContain("function collectResponsesThinkingModels()");
    expect(html).toContain("function responsesThinkingStateKey(models)");
    expect(html).toContain("if(!beginExclusiveAction('responsesThinkingSave','Responses 思考配置保存正在进行中，请稍候'))return;");
    expect(html).toContain("const d=await fetchJsonMutationWithTimeout(API+'/admin/api/responses-thinking',{method:'PUT',headers:authHeaders(),body:JSON.stringify({models})});");
    expect(html).toContain("const currentState=responsesThinkingStateKey(collectResponsesThinkingModels());");
    expect(html).toContain("toast('Responses 思考配置已保存；页面上还有新的未保存修改','warn');");
    expect(html).toContain("function collectProxyPoolConfigForm(options={})");
    expect(html).toContain("function proxyPoolConfigStateKey(config)");
    expect(html).toContain("if(!beginExclusiveAction('proxyPoolConfigSave','代理池配置保存正在进行中，请稍候'))return;");
    expect(html).toContain("const data=await fetchJsonMutationWithTimeout(API+'/admin/api/proxy-pool/config',{");
    expect(html).toContain("const currentState=proxyPoolConfigStateKey(collectProxyPoolConfigForm({showErrors:false}));");
    expect(html).toContain("toast('代理池配置已保存；页面上还有新的未保存修改','warn');");
    expect(html).toContain("if(!dashboardActionCurrent(requestInitGeneration,requestAuthToken))return;");
    expect(html).toContain("endExclusiveAction('responsesThinkingSave');");
    expect(html).toContain("endExclusiveAction('proxyPoolConfigSave');");
  });

  it("serializes debug toggles and ignores stale config writes", () => {
    const html = readDashboardHtml();
    expect(html).toContain("if(!beginExclusiveAction('debugModeToggle','调试开关正在保存中，请稍候')){toggle.checked=!checked;return;}");
    expect(html).toContain("const requestAuthToken=authToken;\n  const requestInitGeneration=dashboardInitGeneration;\n  try{\n    // Fetch current config, flip logging.debug, PUT it back.");
    expect(html).toContain("cfg.logging={...(cfg.logging||{}),debug:checked};");
    expect(html).toContain("cfg.logging={...(cfg.logging||{}),headerDebug:checked};");
    expect(html).toContain("await fetchJsonMutationWithTimeout(API+'/admin/api/config',{method:'PUT',headers:authHeaders(),body:JSON.stringify(cfg)});");
    expect(html).toContain("if(!dashboardActionCurrent(requestInitGeneration,requestAuthToken))return;\n    invalidateConfigSnapshot();");
    expect(html).toContain("if(dashboardActionCurrent(requestInitGeneration,requestAuthToken)){\n      console.error('toggleLogDebugMode failed:',e);");
    expect(html).toContain("if(dashboardActionCurrent(requestInitGeneration,requestAuthToken)){\n      console.error('toggleHeaderDebugMode failed:',e);");
    expect(html).toContain("endExclusiveAction('debugModeToggle');");
  });

  it("guards long-running imports and proxy-pool mutations against duplicate submits", () => {
    const html = readDashboardHtml();
    expect(html).toContain("const _exclusiveActions=new Set()");
    expect(html).toContain("function beginExclusiveAction(key,message='操作正在进行中')");
    expect(html).toContain("if(!beginExclusiveAction('accountImport','账号导入正在进行中，请稍候')){input.value='';return;}");
    expect(html).toContain("const d=await fetchJsonMutationWithTimeout(API+'/admin/api/accounts/import',{method:'POST',headers:authHeaders(),body:JSON.stringify({accounts})},MUTATION_TIMEOUT_MS);");
    expect(html).toContain("finally{input.value='';endExclusiveAction('accountImport');}");
    expect(html).toContain("if(!beginExclusiveAction('proxyPoolMutation','代理池操作正在进行中，请稍候'))return;");
    expect(html).toContain("},LONG_MUTATION_TIMEOUT_MS);");
    expect(html).toContain("await fetchJsonMutationWithTimeout(API+'/admin/api/proxy-pool/proxy',{");
    expect(html).toContain("const data=await fetchJsonMutationWithTimeout(API+'/admin/api/proxy-pool/clear',{");
    expect(html).toContain("endExclusiveAction('proxyPoolMutation');");
    expect(html).toContain("finally{\n    event.target.value=''; // reset so the same file can be re-selected\n  }");
  });
});
