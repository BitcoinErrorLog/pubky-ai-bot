# Weekly legacy post ID recovery

## Scope and invariants

The operator-only recovery targets exactly one `(series, week_key)` at a
time, where `series` is `feedback` or `updates` and `week_key` is
`2026-W36`. The weekly row must exist, be `published`, contain a 13-character
legacy hexadecimal post URI owned by Jeb, and point to a matching standalone
weekly publish request whose `approved_by` is `weekly`. The old row, request,
and URI are retained as audit history.

The recovery must not delete posts, weekly rows, publish requests, handled
mentions, or unrelated rows. It must not update a handled mention to a
predicted URI. The publisher remains the only component allowed to sign and
PUT a post.

## Transaction

1. Parse and validate the explicit series, week, and dry-run/apply mode.
2. In one transaction, lock the selected weekly row and its associated
   publish request.
3. Validate the author key, weekly approval, standalone kind, legacy URI shape,
   and that no recovery is already applied.
4. In dry-run, roll back and print the validated objects.
5. On apply, create an audit/recovery record, insert a new queued publish
   request with a builder-generated strict post ID, and commit.
6. The publisher validates the recovery row and PUTs the persisted ID. Its
   successful completion transaction records the actual URI and updates the
   weekly relationship. Retries reuse the same ID.

## Self-attack table

| Attack or race | Protection |
| --- | --- |
| Wrong series/week | Exact parser plus locked primary-key lookup |
| Non-hex or foreign URI | Strict legacy hex URI and Jeb author validation |
| Duplicate apply | Unique `(series, week_key)` recovery key and `applied` check |
| Partial publish | Recovery remains queued; publisher retry uses persisted ID |
| Retry after PUT | Same `replace_post_id`; completion is idempotent |
| Concurrent weekly tick | Row lock and existing weekly primary key; single-flight tick |

