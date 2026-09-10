# Pubchi golden fixture format

Golden cases are versioned JSON records for planner and scope evaluation. Each
case freezes the question, optional private-context variant, request clock, and
live Scout schema hash. `expected` describes the safe plan class and any
required tool or chain shape. `acceptance` contains named checks implemented by
the golden runner; it is deliberately a finite vocabulary rather than free-form
assertion code.

`context` is either `"none"` or the strict v2 `{about?, instructions?}` object.
`scope.window_days` is an integer for a bounded window or `"all_time"` for a
timeless query. `scope.graph` is `none` for an answer/refusal with no graph
lookup.

The schema is exported from `golden.schema.ts`. Cases must be valid JSON and
must not contain credentials, real private context, or raw upstream evidence.
