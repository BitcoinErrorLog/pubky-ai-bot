-- Drop unused Branch A columns. Standalone posts are rebuilt from
-- post_kind / attachments / replace_post_id (098 + enqueueStandalonePost).

ALTER TABLE publish_requests DROP COLUMN IF EXISTS post_json;
ALTER TABLE publish_requests DROP COLUMN IF EXISTS post_path;
