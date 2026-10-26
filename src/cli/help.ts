import { VERSION } from "../version.js";

export function printHelp(): void {
  console.log(`zcode-proxy ${VERSION}

Usage:
  zcode-proxy                       Interactive terminal UI (default):
                                    login, start/stop, live logs
  zcode-proxy [debug] [config.yaml] Same, with debug diagnostics / custom config
  zcode-proxy serve [config.yaml]   Start the proxy server (classic CLI mode)
  zcode-proxy serve debug [config.yaml]
                                    Start with verbose per-request diagnostics
  zcode-proxy --cli                 Classic CLI mode (bare --cli = serve)
  zcode-proxy android               Android entry: proxy + localhost control listener
  zcode-proxy auth login <provider> Login via OAuth (provider: zai | bigmodel)
                                    Optional: --plan=coding-plan|start-plan
  zcode-proxy auth login <provider> --import [--plan=...]
                                    Import API key from ~/.zcode/v2/config.json
  zcode-proxy auth export [--output FILE] [--quiet]
                                    Print ZCODE_OAUTH_CREDENTIAL value for Render
  zcode-proxy auth logout           Clear stored credentials
  zcode-proxy auth status           Show current authentication state
  zcode-proxy claim [list|now]      List / claim weekend-plan trial packages
  zcode-proxy quota                 Show plan quota (per-model remaining/total)
  zcode-proxy reset                 Show coding-plan usage-window resets
  zcode-proxy reset --use five_hour Spend a 5-hour-window reset (--use week for weekly)
  zcode-proxy reset --opportunity   Ask the server for an automatic reset grant
  zcode-proxy version               Show version
  zcode-proxy help                  Show this help

Examples:
  zcode-proxy                       Terminal UI: login, start/stop, live logs
  zcode-proxy debug                 Terminal UI with per-request diagnostics
  zcode-proxy serve debug           CLI: start with extra debug logging
  zcode-proxy auth login bigmodel   OAuth login for Bigmodel (coding-plan)
  zcode-proxy auth login bigmodel --plan=start-plan
                                    OAuth login targeting the start-plan trial
  zcode-proxy auth login bigmodel --import
                                    Import existing key from ZCode config
  zcode-proxy auth export --output cred.b64
                                    Export credential blob for cloud deploy
  zcode-proxy auth status           Check if logged in
`);
}
