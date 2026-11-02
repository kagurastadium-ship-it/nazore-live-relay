# Nazore LIVE Relay

TikTok LIVE comments relay for Nazore.

Based on the KanjiBunkai LIVE relay.
The original documentation is retained in UPSTREAM_README.md.

## Protocol

WebSocket endpoint: /live
Health endpoint: /health

Subscribe for Nazore:

{"type":"subscribe","tiktokId":"alice","subscriptionId":"uuid","commentMode":"words"}

The words mode allows multi-character comments.
The default kanji mode retains the original filtering behavior.

The game client decides whether a comment is a correct answer.

## Deployment

Render service name: nazore-live
Plan: free
Automatic deployment: disabled

No production deployment is performed by this repository setup.

## License

The inherited relay source retains its AGPL license.
See LICENSE and THIRD_PARTY_NOTICES.md.