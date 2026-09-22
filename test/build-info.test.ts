import { mkdtempSync, mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildInfo } from "../src/ops/build-info.js";

function checkout(): string {
  const root = mkdtempSync(join(tmpdir(), "build-info-"));
  mkdirSync(join(root, ".git", "refs", "heads", "feat"), { recursive: true });
  writeFileSync(join(root, ".git", "HEAD"), "ref: refs/heads/feat/x\n");
  writeFileSync(join(root, ".git", "refs", "heads", "feat", "x"), "0123456789abcdef0123456789abcdef01234567\n");
  mkdirSync(join(root, "src", "strategy"), { recursive: true });
  writeFileSync(join(root, "src", "strategy", "selector.ts"), "// src");
  return root;
}

describe("buildInfo — what code is actually running", () => {
  it("reads the short git revision and reports no dist when running from source", () => {
    const info = buildInfo(checkout());
    expect(info.rev).toBe("0123456");
    expect(info.distBuiltAt).toBeNull();
    expect(info.distStale).toBeNull();
  });

  it("flags dist older than the newest source file (git pull without pnpm build)", () => {
    const root = checkout();
    mkdirSync(join(root, "dist"));
    writeFileSync(join(root, "dist", "index.js"), "// built");
    const old = new Date(Date.now() - 3_600_000);
    utimesSync(join(root, "dist", "index.js"), old, old);
    expect(buildInfo(root).distStale).toBe(true);
    const fresh = new Date(Date.now() + 60_000);
    utimesSync(join(root, "dist", "index.js"), fresh, fresh);
    expect(buildInfo(root).distStale).toBe(false);
  });
});
