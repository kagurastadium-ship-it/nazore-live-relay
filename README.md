# Nazore LIVE Relay — protocol 2

Based on the deployed Nazore/KanjiBunkai relay (AGPL-3.0-only).
The upstream relay/comment parsing implementation is preserved.

This candidate requires Firebase Authentication + App Check + server-side session ACLs.
Unauthenticated protocol-1 clients are intentionally rejected; no insecure fallback exists.
The Web project includes the corresponding minimal client transport update.

See DEPLOYMENT.md for credentials, grants, migration and rollback requirements.
No deployment, push or Firebase setting change is performed by this source preparation.

- `npm ci --ignore-scripts` and `npm test`: isolated server verification.
- `npm start`: requires production verifier credentials and explicit grants.
- `/health`: public static protocol/authentication metadata, no user/session data.
- `/source`: bounded AGPL source offer; no environment values or secret files.
- `/live`: WebSocket only; no SSE or HTTP session-control bypass.
