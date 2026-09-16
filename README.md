# Loro backend

Fastify service for reliable call routing, live English transcription, Spanish translation, and bounded call history. The phone destination remains the answering floor. App answering can be enabled as an additional leg after its separate mobile prerequisites are ready.

## Run locally

Use Node 20 or newer.

```sh
npm install
npm test
npm run dev
```

For a local app walkthrough with fake providers and no external calls:

```sh
npm run demo
curl.exe -X POST http://127.0.0.1:3107/_demo/call
```

To resume a local walkthrough after restarting the demo runner, pass its prior
temporary directory explicitly. Do not use this option outside local demo work.

```sh
npm run demo -- --data-dir "C:\\path\\to\\loro-demo-state"
```

The saved fixture keeps pairing tokens. To pair an additional local browser without
discarding demo history, supply a new demo-only one-time code on restart:

```sh
npm run demo -- --data-dir "C:\\path\\to\\loro-demo-state" --pairing-code LORO-QA2
```

The demo binds only to `127.0.0.1`, uses a new temporary data directory on each run, and has setup code `LORO-DEMO`.

## Configuration

Set runtime values through the hosting service. Do not commit credentials.

| Variable | Purpose | Example |
| --- | --- | --- |
| `PUBLIC_BASE_URL` | Exact public HTTPS origin used for Twilio signatures and stream URLs | `https://loro.example.com` |
| `TARGET_PHONE_NUMBER` | Second phone line that always rings | `+15555550101` |
| `TWILIO_PHONE_NUMBER` | Twilio inbound number and outbound caller ID | `+15555550102` |
| `FORWARDING_SOURCE_NUMBERS` | Comma-separated numbers that forward into Twilio and must never be dialed | `+15555550103` |
| `TWILIO_AUTH_TOKEN` | Validates Twilio HTTP and Media Stream requests | secret |
| `DEEPGRAM_API_KEY` | Live English transcription | secret |
| `ANTHROPIC_API_KEY` | Spanish translation and summaries | secret |
| `APP_PAIRING_CODE` | One-time setup code. Change it to pair another device | `six-or-more-random-words` |
| `DATA_FILE` | Persistent JSON state path on a mounted disk | `/var/data/loro-state.json` |
| `WEB_ALLOWED_ORIGINS` | Explicit browser origins for local/web previews | `http://localhost:8081,http://127.0.0.1:8081` |
| `ENABLE_APP_ANSWER` | Adds the optional Twilio Client answering leg | `false` |
| `GOOGLE_APPLICATION_CREDENTIALS` | Server-only path to Firebase service-account JSON for Android FCM | `/run/secrets/firebase.json` |
| `FIREBASE_SERVICE_ACCOUNT_JSON` | Server-only Firebase service-account JSON when a secret-file path is unavailable | secret |

Optional limits have conservative defaults: `MAX_STORED_CALLS=50`, `MAX_TURNS_PER_CALL=500`, `MAX_QUEUED_AUDIO_BYTES=1000000`, `MAX_PENDING_TRANSLATIONS=50`, `APP_AUTH_TIMEOUT_MS=5000`, `PAIRING_MAX_ATTEMPTS=5`, `PAIRING_WINDOW_MS=60000`, and `MAX_PAIRED_DEVICES=3`.

`TRUSTED_PROXY_HOPS=1` is appropriate when exactly one hosting proxy sits in front of Node. Set it to the known hop count for the host. Pairing limits are keyed by the resulting client IP and the in-memory tracker is capped to prevent unbounded growth.

`APP_PAIRING_CODE` is consumed once. The server stores only a SHA-256 fingerprint of the code and device token. To pair a replacement or second phone, set a new random code and restart. Device tokens stay valid across restarts when `DATA_FILE` is persistent.

## Readiness and protocol

`GET /health` is public and returns `protocolVersion: 2`; release packaging uses this as the migration gate. `POST /pair` exchanges the one-time setup code for a random device token. The app should include its stable, locally generated `deviceId` (16-128 URL-safe characters) when pairing. Re-pairing that same device with a new owner-configured setup code replaces its old token and push registration, avoiding an orphaned-device quota. The token is sent as `Authorization: Bearer ...` to `GET /status`, `POST /devices/push`, and `DELETE /devices/push`. Android registers direct FCM with `{ "token": "...", "provider": "fcm" }`; delete removes only the current paired device. The backend accepts no legacy push providers.

The `/app` WebSocket never accepts tokens in its URL. It sends `hello`, requires `{ "type": "auth", "token": "..." }` within five seconds, then sends the bounded snapshot (active and ended calls), optional unexpired `incomingCalls`, and service status. Call and turn IDs are stable across reconnects. The app sends `{ "type": "ping" }` while connected and receives `{ "type": "pong", "timestamp": "..." }`, allowing it to replace stale open connections.

Each valid inbound `/voice` webhook persists and broadcasts its incoming state before Twilio can start media or dial, then sends an asynchronous direct FCM **data-only** high-priority payload: `{ type: "incoming_call", callSid, from, receivedAt, expiresAt }`. Every field is a string and both times are Unix milliseconds. Android resolves `from` against its local contacts, so contact names are never sent to the backend. Alerts expire in 45 seconds or less; signed terminal `<Number>` status callbacks and the signed `<Dial action>` callback send `{ type: "call_ended", callSid }`. Duplicate Twilio retries remain suppressed for the alert lifetime, including end-before-incoming races. Push failures never delay TwiML/ringing and become a service-status runtime issue without exposing secrets.

Twilio requests to `/voice` and the `/media` WebSocket handshake require `X-Twilio-Signature`. Validation reconstructs the exact external URL from `PUBLIC_BASE_URL`, rather than proxy headers. For Media Streams it accepts only Twilio's documented HTTPS/WSS and trailing-slash canonical variants. A real signed handshake must still be verified on the Twilio number after deployment. No raw audio is persisted and transcript contents are not written to logs.

Before changing failover routing, run the offline guard:

```sh
node scripts/twilio-failover.mjs --target +15555550101 --check
```

The deploy form is the same command without `--check`. It changes Twilio resources, so use it only during an intentional routing change.
