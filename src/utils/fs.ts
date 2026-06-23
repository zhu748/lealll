/**
 * Atomic filesystem write helpers.
 *
 * `fs.writeFile` truncates the target file then writes — a crash between
 * truncate and full write leaves a partial file. For YAML configs and
 * credential stores this means one Ctrl+C during a save can corrupt the
 * file and lock the user out of their own config.
 *
 * `atomicWriteFile` writes to a temp file then renames over the target.
 * POSIX rename(2) is atomic; on Windows, Bun's fs.rename handles the
 * overwrite case (Node has supported it since v10) but can fail with
 * EPERM if the target is briefly locked by antivirus / file indexer —
 * we retry a few times with backoff before giving up.
 */
import { writeFile, rename, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";

/**
 * Windows-safe rename with retry. On POSIX, `rename` is atomic and
 * always succeeds (modulo permissions). On Windows, `rename` over an
 * existing file can fail with EPERM if the target is briefly locked by
 * antivirus / Windows Search indexer / backup tools. We retry up to
 * 5 times with 50ms backoff before surfacing the error.
 *
 * This is the #1 cause of "save failed" reports from Windows users
 * running the dashboard — the actual write succeeds (temp file exists),
 * only the rename races with another process holding a transient lock
 * on the target.
 */
async function safeRename(tmp: string, target: string): Promise<void> {
  const MAX_RETRIES = 5;
  const RETRY_DELAY_MS = 50;
  let lastErr: unknown;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      await rename(tmp, target);
      return;
    } catch (err) {
      lastErr = err;
      const code = (err as NodeJS.ErrnoException)?.code;
      // EPERM/EBUSY/EACCS: transient Windows lock — retry.
      // ENOENT: tmp disappeared (shouldn't happen) — retry won't help.
      // EXDEV: cross-device link — retry won't help, fall through.
      if (code === "EPERM" || code === "EBUSY" || code === "EACCES") {
        await new Promise(r => setTimeout(r, RETRY_DELAY_MS * (attempt + 1)));
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
}

/**
 * Write `content` to `path` atomically: write to `{path}.{pid}.tmp` first,
 * then rename over `path`. If the process crashes mid-write, the temp file
 * is left behind (harmless) and the target file is unchanged.
 *
 * On Windows the rename retries up to 5 times to ride out transient locks
 * from antivirus / Windows Search. If all retries fail the temp file is
 * cleaned up and the error is rethrown.
 *
 * @param path Final destination path.
 * @param content File contents (string or Buffer).
 * @param encoding Text encoding when `content` is a string. Defaults to "utf-8".
 */
export async function atomicWriteFile(
  path: string,
  content: string | Uint8Array,
  encoding: BufferEncoding = "utf-8",
): Promise<void> {
  const tmp = join(dirname(path), `.${process.pid}.tmp-${Date.now()}`);
  await writeFile(tmp, content, encoding);
  try {
    await safeRename(tmp, path);
  } catch (err) {
    // Best-effort cleanup of the temp file if rename failed.
    try { await unlink(tmp); } catch {}
    throw err;
  }
}

/**
 * Simple async mutex. Serializes concurrent callers so they execute in
 * FIFO order. Used to prevent two admin dashboard PUTs from racing on the
 * config file.
 *
 * Usage:
 *   const lock = createMutex();
 *   await lock.run(async () => { /* critical section *\/ });
 */
export interface AsyncMutex {
  /** Run `fn` while holding the lock. Other callers wait. */
  run<T>(fn: () => Promise<T>): Promise<T>;
}

export function createMutex(): AsyncMutex {
  let chain: Promise<unknown> = Promise.resolve();
  return {
    run<T>(fn: () => Promise<T>): Promise<T> {
      const next = chain.then(() => fn());
      // Swallow rejections on the stored chain so a failed task doesn't
      // poison every subsequent task. The returned `next` still surfaces
      // the rejection to the caller.
      chain = next.then(() => undefined, () => undefined);
      return next as Promise<T>;
    },
  };
}
