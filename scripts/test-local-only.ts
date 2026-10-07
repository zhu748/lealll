/** Host fetch/TCP guard. Captcha DOM tests additionally use offline SDK fixtures. */
import { Socket } from "node:net";

function assertLoopback(host: string): void {
  if (host === "localhost" || host === "::1" || host === "[::1]" || /^127\.\d+\.\d+\.\d+$/.test(host)) return;
  throw new Error("External network disabled during tests");
}

const realFetch = globalThis.fetch;
globalThis.fetch = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  assertLoopback(url.hostname);
  return realFetch(input, init);
}, { preconnect: () => {} }) as typeof fetch;

const realConnect = Socket.prototype.connect;
Socket.prototype.connect = function (this: Socket, ...args: any[]) {
  const options = Array.isArray(args[0]) ? args[0] : args;
  const first = options[0];
  if (typeof first === "object" && first !== null) {
    if (!first.path) assertLoopback(first.host ?? "localhost");
  } else if (typeof first === "number") {
    assertLoopback(typeof options[1] === "string" ? options[1] : "localhost");
  }
  return realConnect.apply(this, args as Parameters<typeof realConnect>);
} as typeof realConnect;

const realBunConnect = Bun.connect;
Bun.connect = ((options: Parameters<typeof Bun.connect>[0]) => {
  if ("hostname" in options) {
    if (typeof options.hostname !== "string") throw new Error("Invalid test hostname");
    assertLoopback(options.hostname);
  }
  return realBunConnect(options);
}) as typeof Bun.connect;
