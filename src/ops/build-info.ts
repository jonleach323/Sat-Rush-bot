/**
 * What code is actually running. The service runs `node dist/index.js`, so a
 * `git pull` without `pnpm build` runs yesterday's bot while the checkout
 * says today's — the boot line names the git revision AND whether dist is
 * older than the newest source file, so a stale build is visible in the
 * first line of the journal instead of being inferred from behaviour.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

export interface BuildInfo {
  /** Short git revision of the checkout, or null outside a git checkout. */
  rev: string | null;
  /** ISO time dist/index.js was written, or null when running from source (tsx). */
  distBuiltAt: string | null;
  /** ISO time of the newest file under src/. */
  srcNewestAt: string | null;
  /** True when dist/index.js is older than the newest source file. Null when no dist. */
  distStale: boolean | null;
}

function gitRev(root: string): string | null {
  try {
    const head = readFileSync(join(root, ".git", "HEAD"), "utf8").trim();
    const m = /^ref: (.+)$/.exec(head);
    if (!m) return head.slice(0, 7);
    const refPath = join(root, ".git", m[1]!);
    if (existsSync(refPath)) return readFileSync(refPath, "utf8").trim().slice(0, 7);
    const packed = readFileSync(join(root, ".git", "packed-refs"), "utf8");
    const line = packed.split("\n").find((l) => l.endsWith(` ${m[1]}`));
    return line ? line.slice(0, 7) : null;
  } catch {
    return null;
  }
}

function newestMtimeMs(dir: string): number {
  let newest = 0;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return 0;
  }
  for (const name of entries) {
    const p = join(dir, name);
    let st;
    try {
      st = statSync(p);
    } catch {
      continue;
    }
    if (st.isDirectory()) newest = Math.max(newest, newestMtimeMs(p));
    else newest = Math.max(newest, st.mtimeMs);
  }
  return newest;
}

export function buildInfo(root = process.cwd()): BuildInfo {
  const rev = gitRev(root);
  const dist = join(root, "dist", "index.js");
  const srcNewest = newestMtimeMs(join(root, "src"));
  const srcNewestAt = srcNewest > 0 ? new Date(srcNewest).toISOString() : null;
  if (!existsSync(dist)) return { rev, distBuiltAt: null, srcNewestAt, distStale: null };
  const distMtime = statSync(dist).mtimeMs;
  return {
    rev,
    distBuiltAt: new Date(distMtime).toISOString(),
    srcNewestAt,
    distStale: srcNewest > 0 ? distMtime < srcNewest : null,
  };
}
