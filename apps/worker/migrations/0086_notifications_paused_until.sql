-- When the pause of someone's notifications ends, as Slack's Do Not Disturb pauses them, kept by the
-- Workspace (scope "workspace" in src/migrations.ts) with the person: an ISO time, as toISOString writes
-- it, which the browser works out in its own time zone, since Ember keeps nobody's, or null while they
-- haven't paused them. Until then nothing is pushed to them and no invitation into a huddle rings for
-- them, and the people directory lists them paused. A time that has passed pauses nothing.
ALTER TABLE users ADD COLUMN notifications_paused_until TEXT;
