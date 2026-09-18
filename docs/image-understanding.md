# Image understanding

Jeb reads only public image evidence already referenced by a mention, its ancestor thread, or a Nexus/Scout post returned by an allowed evidence tool.

## Production data contract

Verified against `pubky/pubky-app` dev at `98177fa6abcd20ecbdebb3fde85389d8e5c86014` and `pubky/pubky-nexus` main at `74880a19a0d6b58544814a5858a22a1835f9bd1d`:

- Nexus `PostDetails.attachments` is an optional string array.
- Pubky App file references are `pubky://<owner>/pub/pubky.app/files/<file-id>`.
- Pubky App renders a file's `main` variant at `${CDN}/files/<owner>/<file-id>/main`; its staging CDN default is `${NEXUS_ORIGIN}/static`.
- Long posts store JSON `{ title, body }`. Markdown image destinations can be `attachment:{n}`, a direct Pubky file URI, or HTTPS.
- Nexus file records point at Pubky blob URIs, but Jeb does not follow those records or arbitrary Pubky paths. It uses only the public CDN file variant.

## Runtime configuration

| Env | Default |
| --- | --- |
| `JEB_IMAGE_ENABLED` | `1` (`0` disables) |
| `JEB_IMAGE_MAX_COUNT` | `4` |
| `JEB_IMAGE_MAX_BYTES` | `5242880` |
| `JEB_IMAGE_TOTAL_MAX_BYTES` | `10485760` |
| `JEB_IMAGE_TIMEOUT_MS` | `5000` |
| `JEB_IMAGE_CDN_URL` | `${origin(JEB_NEXUS_URL)}/static` |
| `JEB_IMAGE_ALLOWED_HOSTS` | empty; comma-separated additional exact hostnames |

The CDN hostname is always added to the allowlist. Images are fetched only by the reason role after the existing token-budget gate. Accepted bytes become native image parts in the deployed OpenAI-compatible/Moonshot request; provider-reported image tokens flow through the existing usage and daily-budget accounting.

Every hostname is resolved before connect, every answer is rejected if any resolved address is non-public, and the validated address is pinned into the HTTP(S) connection. Redirects and credentialed URLs are refused. Both declared and streamed byte counts are bounded. Content-Type must be an allowed image type, magic bytes must match it, dimensions are capped at 25 megapixels, and PNG/JPEG/GIF/WebP bytes are decoded through the existing Transformers/Sharp image path. Failures are silent optional-evidence misses: logs never contain image bytes, data URLs, source URLs, signed URLs, or post bodies.
