# arcana-proxy

Arcana LLM API proxy.

## Endpoints (auth: `Authorization: Bearer <proxy_key>`)

| Path | Method | Notes |
|------|--------|--------|
| `/v1/chat/completions` | POST | LLM chat (OpenRouter / Aihubmix / Cloudflare failover) |
| `/v1/embeddings` | POST | Embeddings |
| `/v1/images` | POST | Image generation (alias) |
| `/v1/images/generations` | POST | Image generation (OpenAI-style). Body: `{ prompt, model?, n?, size?, aspect_ratio?, quality? }`. Upstream: OpenRouter `POST /api/v1/images`, Aihubmix `/v1/images/generations`. Credits held/adjusted for billable tiers. |
| `/v1/models` | GET | Catalog (includes image models when providers expose them) |
| `/v1/balance` | GET | Credit balance |
| `/v1/health` | GET | Status; `imageGeneration: true` when image routes are live |
| `/v1/memory` | GET/PUT/DELETE | User FACTS / memory (KV) |
| `/v1/sessions` | GET | Session list |

**Image client (CLI):** Arcana tool `image_generate` posts to `/v1/images/generations` and saves files under `~/.arcana/artifacts/images/`.

Free-burst rate limits apply only to LLM/image generation paths (`/v1/chat/completions`, `/v1/embeddings`, `/v1/images*`), not workspace GETs.

## Security

- **Webhook verification**: PayPal webhooks are verified using the PayPal-Verification-Token header, with token rotation and replay protection via timestamp checks.
- **Email-based auth removed**: All authentication now uses proper key-based mechanisms. Hardcoded fallback email addresses have been removed from the codebase.
- **Error sanitization**: Internal error details are never forwarded to clients. All error responses use generic messages with no leak of internal state, stack traces, or implementation details.

## Development

Requirements: Node.js 18+, Wrangler CLI.
