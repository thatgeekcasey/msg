import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

// The beta workflow, which General's card has a copy add to try betas (docs/self-hosting.md#betas), and Update Ember's.
const WORKFLOW = readFileSync(new URL("./update-ember-beta.yml", import.meta.url), "utf8");
const UPDATE_WORKFLOW = readFileSync(new URL("./update-ember.yml", import.meta.url), "utf8");
const EMBER = "https://github.com/NYLLON-SOFTWARE/ember-cloudflare.git";
const UPDATE_SCRIPT = "apps/worker/scripts/update-ember.ts";

let dir: string;
/** git's settings for these repositories alone, whatever the machine's say. */
let gitEnv: Record<string, string>;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "update-ember-beta-test-"));
  writeFileSync(path.join(dir, "gitconfig"), "[init]\n\tdefaultBranch = main\n");
  gitEnv = {
    GIT_CONFIG_GLOBAL: path.join(dir, "gitconfig"),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "Test",
    GIT_AUTHOR_EMAIL: "test@example.com",
    GIT_COMMITTER_NAME: "Test",
    GIT_COMMITTER_EMAIL: "test@example.com",
  };
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** The script the workflow's step `name` runs, without the indent YAML gives it. */
function scriptOf(name: string): string {
  const lines = WORKFLOW.split("\n");
  const step = lines.findIndex((line) => line.trim() === `- name: ${name}`);
  expect(step, `the step ${name}`).toBeGreaterThan(-1);
  const run = lines.findIndex((line, at) => at > step && /^\s+run:/.test(line));
  const [, indent, script] = /^(\s+)run: (.*)$/.exec(lines[run]!)!;
  if (script !== "|") return script!;
  const indentOf = (line: string) => line.length - line.trimStart().length;
  const after = lines.slice(run + 1);
  const end = after.findIndex((line) => line.trim() !== "" && indentOf(line) <= indent!.length);
  const block = after.slice(0, end === -1 ? undefined : end);
  const deepest = Math.min(...block.filter((line) => line.trim()).map(indentOf));
  return block.map((line) => line.slice(deepest)).join("\n");
}

/** Runs git in `repo`. */
function git(repo: string, ...args: string[]): string {
  const result = spawnSync("git", args, { cwd: repo, encoding: "utf8", env: { ...process.env, ...gitEnv } });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout.trim();
}

/** A stand-in for Ember's repository, given a commit tagged with each of `versions`, whose update script names it. */
function emberWith(...versions: string[]): string {
  const ember = path.join(dir, "ember");
  mkdirSync(path.join(ember, "apps/worker/scripts"), { recursive: true });
  mkdirSync(path.join(ember, "apps/web"), { recursive: true });
  if (!existsSync(path.join(ember, ".git"))) git(ember, "init", "--quiet");
  for (const version of versions) {
    writeFileSync(path.join(ember, UPDATE_SCRIPT), `// ${version}\n`);
    writeFileSync(path.join(ember, "apps/web/index.html"), `<!-- ${version} -->\n`);
    git(ember, "add", ".");
    git(ember, "commit", "--quiet", "-m", version);
    git(ember, "tag", version);
  }
  return ember;
}

/** Runs the workflow's fetch, with `ember` standing in for Ember's repository, and returns the checkout it made. */
function fetchFrom(ember: string): string {
  const runnerTemp = mkdtempSync(path.join(dir, "runner-"));
  const script = scriptOf("Fetch Ember's newest update script");
  expect(script).toContain(`ember=${EMBER}\n`);
  const result = spawnSync("bash", ["-e", "-c", script.replace(`ember=${EMBER}\n`, `ember=file://${ember}\n`)], {
    cwd: dir,
    encoding: "utf8",
    env: { ...process.env, ...gitEnv, RUNNER_TEMP: runnerTemp },
  });
  if (result.status !== 0) throw new Error(`The fetch failed: ${result.stderr}`);
  return path.join(runnerTemp, "ember");
}

describe("Update Ember to its newest beta", () => {
  it("fetches the update script from Ember's newest tag, a release's or a beta's, with each beta before its release", () => {
    const ember = emberWith("v0.4.2", "v0.5.0-beta.9", "v0.5.0-beta.10");
    const checkout = fetchFrom(ember);
    expect(readFileSync(path.join(checkout, UPDATE_SCRIPT), "utf8")).toBe("// v0.5.0-beta.10\n");
    // Ember's scripts alone, since they're all it runs.
    expect(existsSync(path.join(checkout, "apps/web"))).toBe(false);

    const newest = () => readFileSync(path.join(fetchFrom(ember), UPDATE_SCRIPT), "utf8");
    emberWith("v0.5.0");
    expect(newest()).toBe("// v0.5.0\n");
    // By version, whichever was tagged last.
    emberWith("v0.10.0-beta.1", "v0.9.1");
    expect(newest()).toBe("// v0.10.0-beta.1\n");
  });

  it("publishes the newest beta with that script in the copy's checkout, only when asked, and never beside Update Ember", () => {
    expect(scriptOf("Update")).toBe(`node "$RUNNER_TEMP/ember/${UPDATE_SCRIPT}" --publish --beta`);
    expect(WORKFLOW).toContain("on:\n  workflow_dispatch:\n\n");
    // The two push the same branches.
    for (const workflow of [WORKFLOW, UPDATE_WORKFLOW]) expect(workflow).toContain("concurrency:\n  group: update-ember\n");
  });
});
