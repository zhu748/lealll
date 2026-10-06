import { expect, it } from "bun:test";
import { createSerialQueue } from "./serial.js";

it("applies overlapping lifecycle commands in order, including after a failure", async () => {
  const run = createSerialQueue(); const events: string[] = [];
  let ready!: () => void;
  const starting = run(async () => { events.push("starting"); await new Promise<void>(r => { ready = r; }); events.push("started"); });
  const failed = run(() => { events.push("failed"); throw new Error("expected failure"); });
  const stopping = run(() => { events.push("stopped"); });
  await Promise.resolve(); expect(events).toEqual(["starting"]); ready();
  await starting; await expect(failed).rejects.toThrow("expected failure"); await stopping;
  expect(events).toEqual(["starting", "started", "failed", "stopped"]);
});
