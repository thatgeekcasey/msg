# Recorded link previews

`opengraph_cases.json` and `opengraph_expected.json` were recorded from Campfire. The first describes
90 links and a fake Internet to unfurl them on: DNS answers, and the responses a server gives at the
fake public addresses. The second is what Campfire answered for each: the response, the DNS lookups
and the requests the server received.

`../unfurl-cases.test.ts` replays them. Where Ember answers differently on purpose, it says so there,
case by case.

# A recorded push

`web_push_expected.json` was recorded from the web-push gem Campfire sends pushes with: a browser's
keys, a push's message as Rails writes it, the gem's encryption of it for those keys, and the headers
and VAPID token it sends at a fixed time, signed with test keys.

`../web-push.test.ts` checks that a push is written, encrypted and signed as the gem does it.

# Recorded webhook answers

`webhook_cases.json` and `webhook_expected.json` were recorded from Campfire. The first describes 19
answers a bot's webhook can give: its status, headers and body, gzipped or late. The second is what
Campfire's `Webhook#deliver` made of each: the request it sent, the webhook's status, and the text or
file the bot said back, or what it raised.

`../webhook-replies.test.ts` replays them. Where Ember answers differently on purpose, it says so
there.

# Recorded files

`storage.json` and the images in `storage/` were recorded from Campfire: what Marcel named each file,
what Active Storage made of file names, and the blobs of the thumbnails, posters, avatars and logos it
made, with their metadata and the images themselves. `ruby_core.json`'s `byte_ranges` are what Rack
made of each Range header.

`../files.test.ts` checks Ember's file types, metadata, names and byte ranges against them, and
`../uploads.test.ts` uploads some of the images. The worker tests can't read files inside workerd,
so `vitest.config.ts` hands them the images as Base64.

# Payloads tools send Slack

`slack_payloads.json` holds what tools that post to Slack send its incoming webhooks, each written
from the code that sends it, which its `source` links: Prometheus Alertmanager's and Grafana's alerts
from their default templates, GitLab's pipelines, Gitea's pushes and issues, Uptime Kuma's monitors,
and Block Kit's own examples. They aren't recorded from the tools themselves, and the names, addresses
and times in them are made up. Beside each is the message the room makes of it, its body, plain text
and cards, checked by hand against how Slack shows the payload.

`../slack-webhook.test.ts` posts each to a bot's Slack-compatible webhook and checks the message.
