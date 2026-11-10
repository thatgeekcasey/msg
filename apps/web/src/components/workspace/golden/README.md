# Notification setup help

The `.html` files are goldens of the three partials of help with turning notifications on (browser
settings, system settings and install instructions), copied unchanged: what Campfire's Rails views
rendered for each of ten user agents. An empty file is a partial Campfire leaves out for that browser.
`platforms.json` holds those user agents, the platform Rails read from each, and the address the pages
were rendered at.

`../notification-help.test.tsx` renders the help for each of those platforms and reads it against
them, reading "Campfire" as "Ember". The Worker reads the platform from the user agent, which
`apps/worker/test/user-agent.test.ts` checks against Rails' answers for 385 user agents, five of these
ten among them.

They're Campfire's output, under its MIT license, like this repository.
