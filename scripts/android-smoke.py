#!/usr/bin/env python3
"""Exercise the packaged Android entry on Node against a loopback-only upstream."""
import gzip
import http.client
import json
import os
from pathlib import Path
import secrets
import socket
import subprocess
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROOT = Path(__file__).resolve().parents[1]
TEXT = "安卓代理验证正常🙂"


class Upstream(BaseHTTPRequestHandler):
    def log_message(self, *_args):
        pass

    def do_POST(self):
        self.rfile.read(int(self.headers["Content-Length"]))
        message = {
            "id": "msg_android_smoke", "type": "message", "role": "assistant", "model": "glm-4.6",
            "content": [{"type": "text", "text": TEXT}], "stop_reason": "end_turn",
            "stop_sequence": None, "usage": {"input_tokens": 4, "output_tokens": 2},
        }
        payload = gzip.compress(json.dumps(message, ensure_ascii=False).encode())
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Encoding", "gzip")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)


def request(port, path, body=None, token=None):
    connection = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
    headers = {"Content-Type": "application/json", "Accept-Encoding": "identity"}
    if token:
        headers["Authorization"] = "Bearer " + token
    try:
        connection.request("POST" if body is not None else "GET", path,
                           json.dumps(body).encode() if body is not None else None, headers)
        response = connection.getresponse()
        return response.status, response.read()
    finally:
        connection.close()


def main():
    bundle = ROOT / "dist/android/server.cjs"
    if not bundle.is_file():
        raise SystemExit("Run bun run build:android-bundle first")
    upstream = ThreadingHTTPServer(("127.0.0.1", 0), Upstream)
    threading.Thread(target=upstream.serve_forever, daemon=True).start()
    try:
        with tempfile.TemporaryDirectory(prefix="android-smoke-") as temp:
            directory = Path(temp)
            with socket.socket() as control_socket, socket.socket() as proxy_socket:
                control_socket.bind(("127.0.0.1", 0))
                proxy_socket.bind(("127.0.0.1", 0))
                control_port = control_socket.getsockname()[1]
                proxy_port = proxy_socket.getsockname()[1]
            token = secrets.token_hex(16)
            origin = f"http://127.0.0.1:{upstream.server_address[1]}"
            config = directory / "config.yaml"
            config.write_text(f"""server:
  host: 127.0.0.1
  port: {proxy_port}
auth:
  mode: apikey
  apiKey: smoke-only-key
provider: bigmodel
plan: coding-plan
providers:
  bigmodel:
    anthropicBase: {origin}
    openaiBase: {origin}
  zai:
    anthropicBase: {origin}
    openaiBase: {origin}
clientIdentity:
  mode: off
endpointRouting:
  enabled: false
clientSigning:
  enabled: false
clientConfig:
  refreshOnStart: false
subscription:
  checkOnSwitch: false
claim:
  enabled: false
  auto: false
mcp:
  enabled: false
  gateway:
    enabled: false
async:
  enabled: false
retry:
  maxRetries: 0
logging:
  level: error
""", encoding="utf-8")
            env = {key: value for key, value in os.environ.items() if not key.startswith("ZCODE")}
            env.update(ZCODE_PROXY_CONFIG=str(config), ZCODE_PROXY_STORE_DIR=str(directory / "store"),
                       ZCODE_CONTROL_PORT=str(control_port), ZCODE_CONTROL_TOKEN=token, ZCODE_UPDATE_CHECK="off")
            with (directory / "node.log").open("w+") as log:
                process = subprocess.Popen(["node", str(bundle), "android"], cwd=directory, env=env,
                                           stdout=log, stderr=subprocess.STDOUT)
                try:
                    def command(name, **fields):
                        code, raw = request(control_port, "/control", {"cmd": name, **fields}, token)
                        assert code == 200, (code, raw)
                        return json.loads(raw)

                    deadline = time.monotonic() + 15
                    while True:
                        try:
                            status = command("status")
                            if status.get("ok"):
                                break
                        except (OSError, http.client.HTTPException):
                            pass
                        if process.poll() is not None or time.monotonic() > deadline:
                            log.seek(0)
                            raise AssertionError("Android entry did not start: " + log.read())
                        time.sleep(0.05)
                    assert status["loggedIn"] and status["proxyPort"] == 0
                    assert status["proxyStartedAt"] == 0 and not status["oauthPending"]
                    assert request(control_port, "/control", {"cmd": "status"})[0] == 401
                    started = command("startProxy")
                    assert started["ok"] and started["port"] == proxy_port
                    status = command("status")
                    assert status["proxyStartedAt"] == started["startedAt"] > 0
                    assert command("status")["proxyStartedAt"] == status["proxyStartedAt"]
                    assert request(proxy_port, "/health")[0] == 200
                    assert request(proxy_port, "/admin")[0] == 200
                    assert request(proxy_port, "/v1/models")[0] == 200
                    code, raw = request(proxy_port, "/v1/chat/completions", {
                        "model": "glm-4.6", "messages": [{"role": "user", "content": "hello"}],
                    })
                    assert code == 200, raw
                    assert json.loads(raw)["choices"][0]["message"]["content"] == TEXT
                    assert command("setConfig", plan="start-plan")["error"] == "stop_proxy_first"
                    assert command("stopProxy")["ok"]
                    assert command("status")["proxyStartedAt"] == 0
                    assert command("setConfig", provider="zai", plan="start-plan")["ok"]
                    status = command("status")
                    assert status["provider"] == "zai" and status["plan"] == "start-plan"
                    logs = command("getLogs", since=0)
                    assert logs["ok"] and logs["nextSince"] > 0
                    assert command("getLogs", since=logs["nextSince"])["lines"] == []
                    assert command("shutdown")["ok"]
                    assert process.wait(timeout=6) == 0
                    print("Android entry: auth, lifecycle, stable uptime, config, logs, admin, Unicode proxy response and shutdown passed")
                finally:
                    if process.poll() is None:
                        process.terminate()
                        try:
                            process.wait(timeout=5)
                        except subprocess.TimeoutExpired:
                            process.kill()
                            process.wait(timeout=5)
    finally:
        upstream.shutdown()
        upstream.server_close()


if __name__ == "__main__":
    main()
