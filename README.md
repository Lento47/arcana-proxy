# arcana-proxy

Arcana LLM API proxy.

## Security

- **Webhook verification**: PayPal webhooks are verified using the PayPal-Verification-Token header, with token rotation and replay protection via timestamp checks.
- **Email-based auth removed**: All authentication now uses proper key-based mechanisms. Hardcoded fallback email addresses have been removed from the codebase.
- **Error sanitization**: Internal error details are never forwarded to clients. All error responses use generic messages with no leak of internal state, stack traces, or implementation details.

## Development

Requirements: Node.js 18+, Wrangler CLI.
