import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { atomicWriteFile } from "./fs.js";

test("atomicWriteFile uses unique temp names for same-millisecond concurrent writes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "zcode-proxy-fs-"));
  const originalNow = Date.now;
  Date.now = () => 1234567890;
  try {
    await Promise.all([
      atomicWriteFile(join(dir, "a.txt"), "alpha"),
      atomicWriteFile(join(dir, "b.txt"), "beta"),
    ]);

    expect(readFileSync(join(dir, "a.txt"), "utf-8")).toBe("alpha");
    expect(readFileSync(join(dir, "b.txt"), "utf-8")).toBe("beta");
    expect(readdirSync(dir).filter((name) => name.includes(".tmp-"))).toEqual([]);
  } finally {
    Date.now = originalNow;
    rmSync(dir, { recursive: true, force: true });
  }
});
