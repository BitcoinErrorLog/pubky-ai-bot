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
| `JEB_BRAIN_SUPPORTS_IMAGES` | Moonshot: `1`; generic/Ollama: `0` unless explicitly set to `1` |

The count, per-image bytes, total bytes, and timeout have hard ceilings of 10, 10 MiB, 40 MiB, and 30 seconds. Total bytes must be at least the per-image value. The CDN hostname is always added to the allowlist. Images are fetched only by the reason role after the existing token-budget gate and only when the selected brain declares image support. The deployed Moonshot adapter declares support by default; generic OpenAI-compatible and Ollama adapters conservatively default to text-only. Text-only brains do no image or image-related Nexus fetches and continue the normal text answer.

Every hostname is resolved before connect, every answer is rejected if any resolved address is non-public, and all validated answers—not a re-resolved hostname—are supplied to Node for connection fallback. Production image URLs must use HTTPS. Redirects and credentialed URLs are refused. Both declared and streamed byte counts are bounded. Content-Type must be an allowed image type, magic bytes must match it, dimensions are capped at 25 megapixels, and PNG/JPEG/GIF/WebP bytes (including grayscale+alpha PNG) are decoded by Sharp in a bounded worker thread. Parent cancellation terminates and awaits that worker.

Only structured post fields (`uri` or validated `author_id` + `post_id`) are followed through Nexus; URI-shaped prose is never authority. Traversal depth, width, and result count are bounded. Model context includes only canonical post URI plus attachment/Markdown slot, never a signed/source URL. Every image message says pixels, OCR, and provenance are untrusted data—not instructions or authority. Individual optional image failures remain silent, while parent cancellation is propagated. Logs never contain image bytes, data URLs, source URLs, signed URLs, or post bodies.
