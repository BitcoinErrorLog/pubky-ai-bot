# Publishing How I work (operator)

Parent-only. Do not run these from CI. Kill switches must be off (`JEB_SWITCH_REPLIES`, `JEB_SWITCH_GLOBAL`, `JEB_DISABLED`). Do not run under `JEB_CONTRACT_MODE=1`. Key loading is the publisher path (`src/keys.ts`); never print key material.

Regenerate the article from code before every publish:

```bash
cd /Volumes/vibedrive/vibes-dev/pubky-ai-bot-dashboard
npm run how-i-work
npm run content:check
```

Dry-run first (no network, key optional):

```bash
npm run post:publish -- --dry-run --kind long --file content/how-i-work.json
```

## (a) Publish the How I work article

```bash
npm run post:publish -- --kind long --file content/how-i-work.json
```

The command prints the `pubky://<bot>/pub/pubky.app/posts/<ID>` URI and the pubky.app post URL. Copy the `pubky://` URI (or the https post URL) into `JEB_HOW_I_WORK_POST_URI`. Do not commit the live URI if it is environment-specific.

## (b) Edit the article in place later

Use the 13-character post id from the URI (`HOWWORK000001` in the example below):

```bash
npm run how-i-work
npm run content:check
npm run post:publish -- --kind long --file content/how-i-work.json --edit HOWWORK000001
```

`--edit` overwrites the same URI. Existing attachments are dropped unless you pass `--keep-attachment <file uri>` for each one to keep.

## (c) Republish the profile with the How I work link

The profile bio already includes the compact tag vocabulary. The How I work link is omitted unless a URI is provided. Requesting the link without a URI fails.

```bash
# dry-run
JEB_SOURCE_URL='https://github.com/BitcoinErrorLog/pubky-ai-bot' \
JEB_HOW_I_WORK_POST_URI='pubky://<botpk>/pub/pubky.app/posts/<ID>' \
  npm run profile:publish -- --dry-run --how-i-work "$JEB_HOW_I_WORK_POST_URI"

# live PUT
JEB_SOURCE_URL='https://github.com/BitcoinErrorLog/pubky-ai-bot' \
JEB_HOW_I_WORK_POST_URI='pubky://<botpk>/pub/pubky.app/posts/<ID>' \
  npm run profile:publish -- --how-i-work "$JEB_HOW_I_WORK_POST_URI"
```

`JEB_POLICY_URL` is accepted as an alias of `JEB_HOW_I_WORK_POST_URI`. Optional `--image ./avatar.png` is unchanged.

Replies/global switches must stay off for the PUT; the script refuses if they are on.
