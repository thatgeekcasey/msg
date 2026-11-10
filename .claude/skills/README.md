# Agent skills

Claude Code loads these skills for anyone working in this repository, including Claude Code on the
web, which doesn't install plugins. Each folder is an unmodified copy of its publisher's skill, made
with the [`skills` CLI](https://github.com/vercel-labs/skills).

From [cloudflare/skills](https://github.com/cloudflare/skills) at `5339598` (Apache-2.0,
[LICENSE-cloudflare-skills](LICENSE-cloudflare-skills)), the ones Ember's stack uses:

- `cloudflare`: chooses Cloudflare products and links their docs. Its `references/` cover D1,
  bindings, static assets, observability and more.
- `durable-objects`: Durable Objects storage, concurrency, WebSockets, alarms and tests.
- `workers-best-practices`: production patterns and code review for Workers.
- `workers-profiling`: CPU and heap profiles of a deployed Worker or Durable Object.
- `wrangler`: Wrangler commands and configuration.
- `web-perf`: Core Web Vitals and Lighthouse audits.

From [vercel-labs/agent-skills](https://github.com/vercel-labs/agent-skills) at `063bee9` (MIT, as
its `SKILL.md` and README state; the repository has no license file):

- `vercel-react-best-practices`: 70 React performance rules ranked by impact. Its `server-*` rules
  and Next.js advice don't apply here.

From [addyosmani/web-quality-skills](https://github.com/addyosmani/web-quality-skills) at `afa8da9`
(MIT, [LICENSE-web-quality-skills](LICENSE-web-quality-skills)):

- `performance` and `core-web-vitals`: loading and interaction performance (LCP, INP, CLS), measured
  before and after.

`web-perf`, `performance` and `core-web-vitals` record traces through
[Chrome DevTools MCP](https://github.com/ChromeDevTools/chrome-devtools-mcp) when it's connected and
read the code without it. It isn't configured here; add it to your own Claude Code with
`claude mcp add chrome-devtools --scope user npx chrome-devtools-mcp@latest`.

Cloudflare's own [agent setup](https://developers.cloudflare.com/agent-setup/) installs its plugin,
which adds the rest of its skills and its MCP server to Claude Code on your machine:
`claude plugin marketplace add cloudflare/skills`, then `claude plugin install cloudflare@cloudflare`.
Claude Code then also lists the plugin's copies of the six above, as `cloudflare:<name>`.

## Refreshing

Rerun the CLI, then update the commits above:

```sh
export DO_NOT_TRACK=1  # otherwise the CLI reports each install to skills.sh
npx -y skills@1.7.2 add cloudflare/skills --skill cloudflare --skill durable-objects \
  --skill workers-best-practices --skill workers-profiling --skill wrangler --skill web-perf \
  -a claude-code --copy -y
npx -y skills@1.7.2 add vercel-labs/agent-skills --skill vercel-react-best-practices \
  -a claude-code --copy -y
npx -y skills@1.7.2 add addyosmani/web-quality-skills --skill performance --skill core-web-vitals \
  -a claude-code --copy -y
```

Don't use `npx skills update`: it swaps these copies for symlinks into `.agents/skills/`. The
`skills-lock.json` the CLI writes is ignored.
