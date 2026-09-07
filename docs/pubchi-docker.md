# Dedicated Pubchi Dockerfiles

New Railway services cannot consume a repo `railway.toml` as service config, and
Railway IaC does not expose Docker `--target`. Do not rely on the `pubchi` stage
in the root `Dockerfile`. Point each service at a dedicated file:

| Service | IaC `dockerfilePath` | Final image default |
| --- | --- | --- |
| Public Pubchi runtime | `Dockerfile.pubchi` | `ENTRYPOINT ["node", "dist/main.js"]` `CMD ["--role", "pubchi"]` |
| Pubchi migrator | `Dockerfile.pubchi-migrate` | `ENTRYPOINT ["node", "dist/main.js"]` `CMD ["--role", "pubchi-migrate"]` |

The root `Dockerfile` remains the Jeb image. Its default/final stage is still
`--role all`. Leave that file unchanged.

`railway.pubchi.toml` and `railway.pubchi-migrator.toml` are legacy/dev
references. They now set `dockerfilePath` to the dedicated files and do not set
`dockerfileTarget`. Production still has to set the same paths in Railway IaC.

## What the images contain

Both files pin every stage to the same verified Node digest as `Dockerfile`.
Build context copies `package.json`, `package-lock.json`, `tsconfig.json`,
`tsconfig.build.json`, `packages/bot-kit`, `packages/pubchi`,
`packages/pubchi-schemas`, and `src`. After copy, the build replaces the
`src/bot-kit`, `src/pubchi`, and `src/pubchi-schemas` host symlinks with real
trees from `packages/*/src` so `tsc` does not depend on symlink resolution.

`npm run build` still compiles `src/main.ts`. That file statically imports the
Jeb ingest/reason/publish/knowledge graph, so omitting those `src/` modules
would fail the typecheck even though the container default command never
starts those roles. `packages/jeb` is not copied: it is a package.json stub
with no source. `sources.yaml`, embedding warmup, kill-switch drill compile,
and `/app/.cache/jeb-models` are Jeb-only and are not included.

Runtime stages run as uid `10001` (`jeb`), copy production `node_modules` +
`dist` + `package.json` only, set `NODE_ENV=production`, and do not set or
copy credentials.

Static check (no Docker daemon):

```bash
node tests/docker/assert-pubchi-dockerfiles.mjs
```
