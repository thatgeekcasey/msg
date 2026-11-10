import { EMBER_REPOSITORY, type CopyOnGitHub, type ReleaseCheck } from "@ember/protocol";
import type { Env } from "./env";
import { isBeta, releaseNameOf, VERSION } from "./version";

// Whether a newer release of Ember is out, which General settings tells administrators, with how to
// update (docs/self-hosting.md#updating). GitHub's address for a repository's latest release redirects to
// that release's page, whose address ends in its tag, and that's all this asks of GitHub, rather than
// asking its API, whose limit of 60 requests an hour for each IP address the many Workers sharing one
// would spend. A repository that has moved redirects to its new address first. Each isolate keeps what
// GitHub said for six hours, and that it didn't say for ten minutes, before asking again, but a check
// made afresh, as opening Admin makes one, asks again sooner, as the project's owner asked (2026-11-05):
// once a minute has passed since the isolate last asked, so that going in and out of Admin can't keep
// asking. GitHub's latest release is never a pre-release, as Ember's betas are, so nobody on a release
// is told of one; a beta is told of its release (docs/self-hosting.md#betas).

/** Where GitHub sends whoever asks for Ember's latest release. */
const LATEST_RELEASE = `${EMBER_REPOSITORY}/releases/latest`;
const GITHUB = new URL(EMBER_REPOSITORY).origin;
/** What the Worker says it is to GitHub. */
const USER_AGENT = `Ember/${VERSION} (+${EMBER_REPOSITORY})`;
/** How long GitHub has to answer, its redirects and all. */
const CHECK_TIMEOUT_MS = 5_000;
/** The most redirects followed to the latest release's page. */
const MOST_REDIRECTS = 3;
/** How long an isolate keeps the newest release GitHub named, or that it named none. */
export const ANSWER_KEPT_MS = 6 * 60 * 60 * 1000;
export const NO_ANSWER_KEPT_MS = 10 * 60 * 1000;
/** How soon after an isolate last asked GitHub a check made afresh asks again: one made sooner says what GitHub said then. */
export const AFRESH_AFTER_MS = 60 * 1000;

/** The page of a repository's latest release, which redirects to that release's, and that release's, whose path ends in its tag. */
const LATEST_PAGE = /^\/[^/]+\/[^/]+\/releases\/latest$/;
const RELEASE_PAGE = /^\/[^/]+\/[^/]+\/releases\/tag\/v(\d+\.\d+\.\d+(?:-beta\.\d+)?)$/;

/** A release of Ember: its version, such as "0.2.0", and the address of its page on GitHub, which has its notes. */
interface Release {
  version: string;
  page: string;
}

/** The newest release GitHub last named, or null when it named none, and until when that's kept. */
let heard: { release: Release | null; until: number } | undefined;
/** When this isolate last asked GitHub, or 0 before it has. */
let askedAt = 0;

/** Forgets the newest release GitHub named, and when it was asked, as an isolate starting afresh has, so that the next check asks again. */
export function forgetNewestRelease(): void {
  heard = undefined;
  askedAt = 0;
}

/**
 * What General settings says of releases: this Ember's, and the newest on GitHub, with whether it's newer,
 * or null when GitHub didn't name one, and the copy this is on GitHub, which it says how to update. GitHub
 * is asked again only once what it said last is no longer kept, or for a check made `afresh` a minute
 * after this isolate last asked, in a subrequest for each address it redirects to. Requests that find it
 * due at the same time each ask, since a subrequest belongs to the request that made it, which can end
 * first, but one that hears no release doesn't replace a release another heard meanwhile, or one that's
 * still kept.
 */
export async function releaseCheck(env: Env, afresh = false): Promise<ReleaseCheck> {
  if (!heard || Date.now() >= heard.until || (afresh && Date.now() >= askedAt + AFRESH_AFTER_MS)) {
    askedAt = Date.now();
    const release = await newestOnGitHub().catch((error: unknown) => {
      console.warn("Asking GitHub for Ember's newest release failed:", error instanceof Error ? error.message : "unknown error");
      return null;
    });
    if (release || !heard?.release || Date.now() >= heard.until) heard = { release, until: Date.now() + (release ? ANSWER_KEPT_MS : NO_ANSWER_KEPT_MS) };
  }
  const newest = heard.release;
  return {
    release: releaseNameOf(VERSION),
    beta: isBeta(VERSION),
    newest: newest && { release: releaseNameOf(newest.version), notes: newest.page, newer: isNewer(newest.version, VERSION) },
    copy: copyOf(env),
  };
}

/** A repository's `owner/name`, in the characters GitHub allows in each. */
const REPOSITORY = /^[\w-]+\/[\w.-]+$/;

/**
 * The copy of Ember this is on GitHub, as `pnpm run deploy` told the Worker, or null where it didn't,
 * as it doesn't for Ember's own repository, nor for a deploy by any other means.
 */
function copyOf(env: Env): CopyOnGitHub | null {
  const repository = env.GITHUB_REPOSITORY?.trim() ?? "";
  const branch = env.GIT_BRANCH?.trim() ?? "";
  return REPOSITORY.test(repository) && branch ? { repository, branch, workflow: env.UPDATE_WORKFLOW === "true" } : null;
}

/** Ember's newest release, as GitHub's page for its latest redirects to that release's, or null when it doesn't. */
async function newestOnGitHub(): Promise<Release | null> {
  const signal = AbortSignal.timeout(CHECK_TIMEOUT_MS);
  let address = LATEST_RELEASE;
  for (let redirects = 0; redirects < MOST_REDIRECTS; redirects++) {
    const answer = await fetch(address, { redirect: "manual", headers: { "User-Agent": USER_AGENT }, signal });
    await answer.body?.cancel();
    const location = answer.status >= 300 && answer.status < 400 ? answer.headers.get("Location") : null;
    if (location === null) return noRelease(`GitHub answered ${answer.status}`);
    const next = new URL(location, address);
    const version = next.origin === GITHUB ? RELEASE_PAGE.exec(next.pathname)?.[1] : undefined;
    // Never a beta, which GitHub doesn't take for the latest, but should it name one, nobody on a release hears of it.
    if (version && isBeta(version) && !isBeta(VERSION)) return noRelease(`GitHub's latest release is a beta, ${next.href}`);
    if (version) return { version, page: next.href };
    if (next.origin !== GITHUB || !LATEST_PAGE.test(next.pathname)) return noRelease(`GitHub redirected to ${next.href}`);
    address = next.href;
  }
  return noRelease(`GitHub redirected more than ${MOST_REDIRECTS} times`);
}

/** That GitHub didn't name a release, as `why` says, which is logged. */
function noRelease(why: string): null {
  console.warn(`GitHub didn't name Ember's newest release: ${why}`);
  return null;
}

/**
 * A version's numbers, such as [0, 1, 0] for "0.1.0", and then its beta's, which is Infinity for a
 * release, as it comes after its betas: [0, 5, 0, 1] for "0.5.0-beta.1", and [0, 5, 0, Infinity] for "0.5.0".
 */
function numbersOf(version: string): number[] {
  const [, ...numbers] = /^(\d+)\.(\d+)\.(\d+)(?:-beta\.(\d+))?$/.exec(version) ?? [];
  return numbers.map((number) => (number === undefined ? Infinity : Number(number)));
}

/** Whether version `a` comes after version `b`. */
export function isNewer(a: string, b: string): boolean {
  const [later, earlier] = [numbersOf(a), numbersOf(b)];
  const differs = later.findIndex((number, at) => number !== earlier[at]);
  return differs !== -1 && later[differs]! > (earlier[differs] ?? -1);
}
