-- Jeb production public key. His own posts stay excluded as weekly sources;
-- posts mentioning or replying to this id count as Jeb discussion.
-- Source: this repo README (Jeb reply URI) and
-- pubky-app-specs/docs/proposals/bot-automation-field.md.
-- No other official project social pubkys were verified in
-- /Volumes/vibedrive/vibes-dev/pubky-knowledge-base or this repo's KB ingest;
-- 8pinxxgqs41n4aididenw5apqp1urfmzdztr8jt4abrkdn435ewo is the testnet
-- homeserver identity, not a project account.
UPDATE tracked_projects
SET pubky_ids = ARRAY['9o6xrx8wgqu48dmb47uep6w3dgbwdnf5jgw83gbeuxg9yi7x444y']
WHERE id = 'jeb';
