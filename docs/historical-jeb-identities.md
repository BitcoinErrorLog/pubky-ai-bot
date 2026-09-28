# Historical Jeb identity allowlist

Persona migration accepts only these Jeb public identities:

| Key | Role | Operational evidence |
| --- | --- | --- |
| `9o6xrx8wgqu48dmb47uep6w3dgbwdnf5jgw83gbeuxg9yi7x444y` | Current production Jeb | Current production configuration and public Jeb profile recorded in the production runbook. |
| `3mi6jsxs9xezxc3a7xn6g7j49q6dsosxsjp39m8pgijuwed4oemy` | Historical production Jeb | Production `handled_mentions` records three published replies under this author key on 2026-09-03: `0035N64TVJP10`, `0035N6EB2W3E0`, and `0035N6F026TPG`. The records predate the current key and retain their original `bot_id` as immutable provenance. |

No other historical key may be bound to persona `jeb`. Adding one requires a
reviewed change to this runbook, the migration allowlist, and the migration
tests with an authoritative production or public-profile record.

Backfill sets `target_bot_pk` to the configured current key while preserving
the historical `handled_mentions.bot_id`. Re-delivery or operator requeue under
a different key treats the old mention as already handled and never publishes
a replacement.
