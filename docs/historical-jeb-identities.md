# Historical Jeb identity allowlist

Persona migration accepts only these Jeb public identities:

| Key | Role | Operational evidence |
| --- | --- | --- |
| `9o6xrx8wgqu48dmb47uep6w3dgbwdnf5jgw83gbeuxg9yi7x444y` | Current production Jeb | Current production configuration and public Jeb profile recorded in the production runbook. |
| `3mi6jsxs9xezxc3a7xn6g7j49q6dsosxsjp39m8pgijuwed4oemy` | Historical production Jeb | Three production `publish_requests` rows match posts still readable directly from this key's homeserver; details below. |

## Signed homeserver evidence

On 2026-09-28, `@synonymdev/pubky` `PublicStorage.getJson()` read each
`pubky://` URI directly through PKARR/homeserver resolution, without Nexus.
The SHA-256 of each returned post's `content` exactly matched the corresponding
production `publish_requests.content` hash:

| `publish_requests.id` | Published URI | Parent mention | `content` SHA-256 | Published |
| ---: | --- | --- | --- | --- |
| 1 | `pubky://3mi6jsxs9xezxc3a7xn6g7j49q6dsosxsjp39m8pgijuwed4oemy/pub/pubky.app/posts/0035N64TVJP10` | `pubky://45synendby7ebxh68mqcehobr4ytswqe8d1bujgidxr9wynf3nfy/pub/pubky.app/posts/0035N64TDRFMG` | `b9e49fd5639817d092841c58b3ff8ba99f734040f27500951defcf3d25a596ac` | 2026-09-03 18:49 UTC |
| 2 | `pubky://3mi6jsxs9xezxc3a7xn6g7j49q6dsosxsjp39m8pgijuwed4oemy/pub/pubky.app/posts/0035N6EB2W3E0` | `pubky://bcatw5daie7w7c8ifz3s4toqbrs9z8568khnukc6tq5gojhag9gy/pub/pubky.app/posts/0035N6E8E9VTG` | `56cbd4d0b65596ac9554728b39beda5fc69fbaee34a29aeaecb39b3cc46a5caa` | 2026-09-03 20:14 UTC |
| 3 | `pubky://3mi6jsxs9xezxc3a7xn6g7j49q6dsosxsjp39m8pgijuwed4oemy/pub/pubky.app/posts/0035N6F026TPG` | `pubky://fado4r5k3hwfqe6qjunreykp9gad3kfwdc7epd7y8nztgis5gmhy/pub/pubky.app/posts/0035N6EYH63FG` | `937dfdda8943e389e9d587b48e44e14184e44282dc9932d2583f03ebe75004e2` | 2026-09-03 20:19 UTC |

The returned posts are `kind=short` and each returned `parent` equals the
recorded mention. Homeserver storage is authenticated by that public key; the
three independent content-hash matches bind this key to Jeb publisher rows,
not merely to historical notification data.

No other historical key may be bound to persona `jeb`. Adding one requires a
reviewed change to this runbook, the migration allowlist, and the migration
tests with an authoritative production or public-profile record.

Backfill sets `target_bot_pk` to the configured current key while preserving
the historical `handled_mentions.bot_id`. Re-delivery or operator requeue under
a different key treats the old mention as already handled and never publishes
a replacement.
