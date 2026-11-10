import { UPDATING_EMBER, type CopyOnGitHub, type ReleaseCheck } from "@ember/protocol";
// Ember's Update Ember workflow, as the deploy offers it to a copy without one (apps/worker/scripts/deploy.ts).
import UPDATE_WORKFLOW from "../../../../worker/scripts/update-ember.yml?raw";
import { BUTTON } from "./email-settings";

// The Ember version card at the end of General, for administrators: the release this Ember is, and once
// GitHub names a newer one, that it's out, with its notes and how to update, as the project's owner
// asked (2026-10-31), while the rail's Admin has a dot. A copy made with Deploy to Cloudflare gets a pull
// request for each release once it has the Update Ember workflow, which Cloudflare's copy leaves out
// (docs/self-hosting.md#updating), and the docs say how anything else updates. Where the deploy told the
// Worker which copy on GitHub this is, the card links straight to running its workflow, as the project's
// owner asked (2026-11-05), or to adding it. A beta says it's one, ahead of the newest release, until its
// release is out (docs/self-hosting.md#betas).

const NOTE = "text-[0.8em] text-muted-foreground max-md:text-[12px]";

/** How a copy made with Deploy to Cloudflare updates, which the card says while a newer release is out. */
export const HOW_COPIES_UPDATE =
  "A copy made with Deploy to Cloudflare gets a pull request for each release from its Update Ember workflow, every Monday or when it's run from the repository's Actions tab, once the workflow is added to the copy, as How to update says. Merging it updates Ember.";
/** Where the workflow's update goes instead of a pull request, as update-ember.ts files it. */
const UNLESS_IT_CANT =
  "Where GitHub doesn't yet let it open pull requests, as in a new repository, it opens an issue instead, with a link that opens the pull request for you to merge.";
/** And how this copy updates, where the Worker knows it has the workflow, or that it hasn't. */
export const HOW_THIS_COPY_UPDATES = `This copy gets a pull request for each release from its Update Ember workflow every Monday. To update now, open the workflow on GitHub, choose Run workflow, and merge the pull request it opens. ${UNLESS_IT_CANT}`;
export const HOW_TO_ADD_THE_WORKFLOW = `This copy has no Update Ember workflow yet, which brings each release as a pull request. Add it on GitHub, where it's filled in for you to commit, then run it from the repository's Actions tab and merge the pull request it opens. ${UNLESS_IT_CANT}`;

/** Where the workflow is in a copy. */
const WORKFLOW_FILE = ".github/workflows/update-ember.yml";

/** The page of `copy`'s Update Ember workflow on GitHub, whose Run workflow runs it. */
export const workflowPageOf = ({ repository }: CopyOnGitHub) => `https://github.com/${repository}/actions/workflows/update-ember.yml`;

/**
 * GitHub's editor for a new file on the branch of `copy` that deploys, filled in with Ember's Update Ember
 * workflow for them to commit, as the deploy's log links to it.
 */
export function addWorkflowLinkOf({ repository, branch }: CopyOnGitHub): string {
  // A branch's name may hold what a link can't, such as `#`, so each of its parts goes in encoded.
  const encoded = branch.split("/").map(encodeURIComponent).join("/");
  return `https://github.com/${repository}/new/${encoded}?${new URLSearchParams({ filename: WORKFLOW_FILE, value: UPDATE_WORKFLOW })}`;
}

/** What the card says of updating `copy`, with its link: to running the copy's workflow, or adding it, or for a copy the Worker doesn't know, to the docs. */
function updating(copy: CopyOnGitHub | null): { says: string; link: string; href: string } {
  if (!copy) return { says: HOW_COPIES_UPDATE, link: "How to update", href: UPDATING_EMBER };
  if (copy.workflow) return { says: HOW_THIS_COPY_UPDATES, link: "Open GitHub action to update", href: workflowPageOf(copy) };
  return { says: HOW_TO_ADD_THE_WORKFLOW, link: "Add GitHub action to update", href: addWorkflowLinkOf(copy) };
}

/** What the card says of this Ember under its heading: which release it is while a newer one is out, else whether it's the newest, or a beta ahead of it. */
function noteOf({ release, beta, newest }: ReleaseCheck): string {
  if (newest?.newer) return `This is Ember ${release}.`;
  if (beta) return newest ? `This is a beta, ahead of Ember ${newest.release}, the newest release.` : "This is a beta. GitHub didn't say whether its release is out.";
  return newest ? "This is the newest release." : "GitHub didn't say whether a newer release is out.";
}

/** The release this Ember is, and whether a newer one is out, once the Worker has said, as it does only for administrators. */
export function EmberVersion({ check }: { check: ReleaseCheck | null }) {
  if (!check) return null;
  const { release, newest, copy } = check;
  const newer = newest?.newer ? newest : null;
  const update = updating(copy);
  return (
    <section aria-labelledby="ember-version-heading" className="flex flex-col gap-3 rounded-[10px] border bg-surface px-[2ch] py-4 text-start max-md:px-3">
      <div>
        <h2 id="ember-version-heading" className="text-base font-semibold">
          {newer ? `Ember ${newer.release} is available` : `Ember ${release}`}
        </h2>
        <p className={NOTE}>{noteOf(check)}</p>
      </div>
      {newer && (
        <>
          <p className={NOTE}>{update.says}</p>
          <div className="flex flex-wrap gap-[1ch]">
            <a href={newer.notes} target="_blank" rel="noopener" className={BUTTON}>
              What's new
            </a>
            <a href={update.href} target="_blank" rel="noopener" className={BUTTON}>
              {update.link}
            </a>
          </div>
        </>
      )}
    </section>
  );
}
