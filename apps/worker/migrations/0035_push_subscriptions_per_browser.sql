-- Each browser's push subscription once, and each person's ten saved most recently, kept by the
-- Workspace (scope "workspace" in src/migrations.ts). Campfire tells subscriptions apart by their
-- endpoint and both keys (users/push_subscriptions_controller.rb), so a browser saving other keys adds
-- one, and a message is pushed to every one: someone saving a subscription thousands of times, each with
-- keys of their own making, would have every message that notifies them pushed thousands of times. A
-- push service's endpoint names one browser's subscription, so here a person has each endpoint once,
-- saving it again replaces its keys, and saving past MAX_PUSH_SUBSCRIPTIONS (@ember/protocol), ten when
-- this was written, forgets the one saved longest ago. Of the subscriptions saved before, the one saved
-- most recently at each endpoint is kept, then each person's ten saved most recently.
DELETE FROM push_subscriptions WHERE id IN (
  SELECT id FROM (
    SELECT id, row_number() OVER (PARTITION BY user_id, endpoint ORDER BY updated_at DESC, id DESC) AS recency
    FROM push_subscriptions
  )
  WHERE recency > 1
);
DELETE FROM push_subscriptions WHERE id IN (
  SELECT id FROM (
    SELECT id, row_number() OVER (PARTITION BY user_id ORDER BY updated_at DESC, id DESC) AS recency
    FROM push_subscriptions
  )
  WHERE recency > 10
);
DROP INDEX IF EXISTS index_push_subscriptions_on_user_id_and_keys;
CREATE UNIQUE INDEX index_push_subscriptions_on_user_id_and_endpoint ON push_subscriptions (user_id, endpoint);
