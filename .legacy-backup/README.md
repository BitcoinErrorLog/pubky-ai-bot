# Legacy stranded commit archive

This bundle preserves the exact objects stranded in the ExFAT legacy checkout on 2026-09-21.

Heads included:

- `fix/pubchi-golden-fixture` (`43d1673`)
- `feat/resource-identity-align` (`5c3317a`)
- `feat/resource-taxonomy-config` (`8f08d20`)
- `stage1/extract-pre-rewrite` (`31aa062`, `46806f7`, `b3039a1`, `6f028a0`, `82fbf70`, `363b46d`)
- `stage0/modernize` (`2241350`)

The bundle was made with `origin/deploy/pubchi-v1` as its prerequisite and was verified in a fresh clone at the same baseline. Restore with `git fetch .legacy-backup/legacy-vibedrive-stranded-2026-09-21.bundle 'refs/*:refs/legacy-restore/*'`.
