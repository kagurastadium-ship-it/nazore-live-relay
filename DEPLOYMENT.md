# Deployment preparation — NOT deployed

## Exact target

Render service **nazore-live**, URL `https://nazore-live.onrender.com`, WebSocket `/live`.
Repository: `kagurastadium-ship-it/nazore-live-relay`.
Do not modify the separate KanjiBunkai relay or any other ORL application.
The internal Render service ID, actual plan, log retention/streaming and members were not accessible in this task; verify the dashboard URL before changes.
Copy this standalone folder's contents into the dedicated relay repository only in a separately approved change. No commit/push is performed here.

## Mandatory configuration

- `FIREBASE_PROJECT_ID`: `nazore-web-orl`.
- `FIREBASE_APP_IDS`: comma-separated **approved Firebase app IDs**, including the current Web app and separately verified iOS app if used. Not API keys.
- `GOOGLE_APPLICATION_CREDENTIALS`: `/etc/secrets/firebase-auth-verifier.json`.
- `NAZORE_LIVE_GRANTS_JSON`: array of `{ownerUid,tiktokIds,participantUids}`. Real values belong in Render's access-controlled environment, never in source, URLs, logs or client bundles. Example shape with placeholders: `[{"ownerUid":"OWNER_FIREBASE_UID","tiktokIds":["approved_broadcaster"],"participantUids":["APPROVED_PARTICIPANT_UID"]}]`.
- `NAZORE_ALLOWED_ORIGINS`: exact comma-separated trusted browser origins. Include `https://nazore-web-orl.web.app` and, if used, `https://nazore-web-orl.firebaseapp.com` and the verified Capacitor origin. Origin-absent native sockets still require both tokens and ACL verification. Origin is never authentication.
- `HOST`: `0.0.0.0`; `PORT`: supplied by Render.
- `EULER_API_KEY`: existing upstream signing key only if already required; keep its value in Render secret environment and do not rotate it in this task.
- `NAZORE_TRUST_PROXY`: default **unset**. The default ignores spoofable forwarding headers. Use `1` only after verifying Render's appended trusted-hop IP behavior. If all sockets appear behind one proxy, peer-IP throttling may aggregate users; assess before cutover. UID quotas remain independent.
- `DEBUG`, `NODE_DEBUG`, `DEBUG_DESERIALIZE_XD`, `GOOGLE_SDK_NODE_LOGGING`, `GRPC_TRACE`: must be unset. Startup fails rather than enabling raw SDK/network diagnostics.
- Auth/App Check emulator environment variables are forbidden.

Use a dedicated least-privilege Google identity for server-side revocation checking. `firebaseauth.users.get` is required; avoid granting data-write, Editor or Owner permissions. Configure approved Workload Identity credentials if available; otherwise use a dedicated service-account credential as a Render **Secret File**, with rotation/revocation handled by the operator. Do not place credential JSON in the repository or transmit its contents in chat. Do not reuse a personal gcloud/Firebase CLI token.
The server uses the official Firebase Admin SDK `verifyIdToken(token,true)` and `verifyToken(appCheckToken)`; revoked/disabled users and foreign app IDs are rejected. No Firebase database writes or custom-claim changes are required by this design.

## User/session model

Web production already signs guests in anonymously with Firebase. Anonymous ID tokens are accepted for explicitly granted UIDs, so a visible Google/email login is not imposed on normal play. Register the legitimate broadcaster UID(s) before enabling the protected server. Clearing guest identity creates a different UID and requires a new grant; linking an account is optional. Offline local/mock play remains unchanged; a local-only repository without Firebase identity cannot use real protected cloud LIVE.
The Firebase UID alone is insufficient: owner UID must have a target-specific server grant. Participants need the exact server-created session ID **and** membership in that owner's allowed-participant list. The current Web/Capacitor client operates as an owner; no unrelated participant UI is added. Devices sharing the same authenticated owner UID can resume the same session.
Never grant every UID or accept arbitrary broadcaster IDs. Operations personnel must establish the broadcaster/owner relationship; this implementation does not pretend that a typed TikTok ID proves TikTok account ownership.

## Protocol 2

First WebSocket frame is `authorize` with runtime ID/App Check tokens, role, broadcaster ID and subscription ID. No TikTok connection starts yet. Server replies `authorized` with session ID, role and expiry. Only then is the original `subscribe`/`round`/comment flow used.
Owner authorization creates/resumes a session; participant authorization includes its `sessionId`. Only owners may send `stop`. A participant may advance only its own round cursor. Owner disconnect grants 15 seconds for reconnection, bounded by session expiry; then remaining participants and upstream subscriptions are cleaned up. Sessions last at most five minutes and no longer than either token. Expiry closes with 4001; the updated client obtains fresh credentials and reconnects. No keep-awake polling or per-comment auth requests are added.
Malformed/unauthorized frames close with 1008, capacity/rate refusal with 1013. Invalid auth never falls back to public subscribe. Tokens are ordinary bearer credentials: possession of a stolen valid token is not made harmless by this protocol. TLS, no token logging and revocation checks remain necessary.

## Ordered rollout — requires separate approval

1. Record the current Render deploy ID/config and Hosting release. Prepare a protected staging service or a bounded maintenance window. The current unprotected `/live` remains exposed until an operator suspends/restricts or replaces it; do not assume the local patch protects it. Suspension itself is NOT performed here.
2. Verify Render service URL/repository and log membership/retention/streaming. Prepare server credentials and explicit grants without displaying values. Test the verifier against a separate test Firebase project/identity where possible. Check native app IDs and origins.
3. Deliver updated Web and iOS clients before cutover. Old protocol-1 Web pages/native bundles will be rejected by the protected server; there is deliberately no insecure compatibility mode. Existing tabs must reload, and installed iOS apps need a coordinated update. Do not silently expose the old unauthenticated endpoint as a fallback.
4. Deploy the protected relay in the approved window, then update only Nazore Hosting with the matching client. Do not deploy unrelated Firebase Functions/Rules or the KanjiBunkai service. New client -> old server is also fail-closed, so a gap in service is expected during a sequential same-URL rollout. Prefer a separately verified protected staging URL if zero-downtime validation is required.
5. `/health` must return protocol 2/authentication required. Also test a real approved identity+App Check+grant, foreign/expired/revoked identities, another session, stop permissions, reconnect and TikTok comment flow. A 200 health response or WebSocket 101 alone does NOT prove authentication works.
6. Confirm comments auto-answer, the five-second transition, pause/resume, browser/mobile geometry and cleanup. Finalize the LIVE privacy notice from actual log settings before public rollout.

## Rollback

Prefer reverting the matching protected server/client pair while retaining the access gate. Record the last **protected** deploy IDs for subsequent releases. The current production relay is unprotected: restoring it is a security rollback and must not be an automatic availability fix. If authentication fails during this first migration, suspend the relay or leave it fail-closed, keep normal/offline/mock game functions available, and fix the credentials/grants or redeploy the protected candidate. Do not add a legacy unauthenticated bypass. Firebase Hosting release rollback does not roll back Render, Firebase Auth or user data.

## Logging and privacy

Application diagnostics are fixed categories; no tokens, comments, usernames, session IDs or raw errors are logged. Rate-limit keys use per-process HMACs and are swept within about two minutes; no raw-IP rate database is written. Connection/session UID and target data are memory-only, bounded by five minutes and cleanup. Explicit access grants remain in server configuration until the operator changes them.
Render infrastructure/HTTP logs, actual retention/reader permissions, external log sinks and third-party SDK behavior in a live upstream session still require operator verification. The checked connector has a raw protobuf debug branch guarded by DEBUG_DESERIALIZE_XD; startup forbids it. Never claim that the platform stores no IPs/logs without checking its real configuration.
