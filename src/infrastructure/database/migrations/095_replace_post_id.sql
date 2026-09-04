-- In-place re-answer: publisher overwrites an existing bot reply (same post id)
-- instead of creating a second post. NULL means a normal new reply.

ALTER TABLE publish_requests ADD COLUMN IF NOT EXISTS replace_post_id TEXT;
