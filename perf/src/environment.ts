import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

export interface Environment {
  date: string;
  commit: string;
  profile: string;
  /** "wrangler dev" with where its local state lived, or the URL that was tested. */
  target: string;
  cpu: string;
  cores: number;
  memoryGb: number;
  os: string;
  node: string;
  wrangler: string;
  workerd: string;
  lighthouse: string;
}

const require = createRequire(import.meta.url);

function packageVersion(name: string, from = require): string {
  try {
    return (from(`${name}/package.json`) as { version: string }).version;
  } catch {
    return "unknown";
  }
}

function gitCommit(): string {
  try {
    const sha = execFileSync("git", ["rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim();
    const dirty = execFileSync("git", ["status", "--porcelain", "--untracked-files=no"], { encoding: "utf8" }).trim();
    return dirty ? `${sha} (with uncommitted changes)` : sha;
  } catch {
    return "unknown";
  }
}

export function environment(profile: string, target: string): Environment {
  const wranglerRequire = createRequire(path.join(path.dirname(require.resolve("wrangler/package.json")), "package.json"));
  return {
    date: new Date().toISOString(),
    commit: gitCommit(),
    profile,
    target,
    cpu: os.cpus()[0]?.model.trim() ?? "unknown",
    cores: os.availableParallelism(),
    memoryGb: Math.round(os.totalmem() / 2 ** 30),
    os: `${os.type()} ${os.release()}`,
    node: process.version,
    wrangler: packageVersion("wrangler"),
    workerd: packageVersion("workerd", wranglerRequire),
    lighthouse: packageVersion("lighthouse"),
  };
}
