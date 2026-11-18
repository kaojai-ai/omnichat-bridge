# LINE Personal extension feasibility gate

Development-only work for the LINE Personal provider. The production extension
and existing Shopee/LINE OA behavior are unchanged. The complete provider,
incoming forwarding, account configuration and backend registration are pending
the live extension gate; this probe must not be published as the feature.

## Run

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm check:line-personal-browser
pnpm build:line-personal-probe
```

Load `tmp/line-personal-probe/extension` through Chrome's **Load unpacked**.
This is a development build of the existing extension, with the additional
LINE API, encrypted transport and attachment origins declared in its generated
manifest. Open its popup and choose **Open LINE Personal development probe**.
Do not configure production forwarding endpoints in this development build.

Use a separate test account. Check the test-account consent box, click Connect,
scan the QR code and approve the PIN on the phone. Receive a test message, then
use **Use latest incoming chat** and manually send a response to that same test
chat. Repeat for a test group. The destination field remains fixed until the
user changes it; later incoming messages do not retarget a prepared send.

For the user's own OA as a test peer, select the explicit **OA test mode** before
sending. The default still requires Letter Sealing, and a failed encrypted
attempt never falls back to OA mode. Preparation failures are reported as
`not_dispatched`; errors after dispatch begins remain `uncertain`.

The probe uses memory-only storage and never forwards to KaoJai. Stop aborts
requests and discards the session locally; it does not revoke LINE's linked
device authorization. Use LINE's logged-in-device controls to revoke it.

## Compatibility facade

Pinned LINEJS 3.6.5 does not bundle for Chrome unchanged. Its high-level entry
imports call/UDP functionality, and its base entry still imports Node builtins.
The probe uses the base entry, browser fetch, browser polyfills, and Noble's
HKDF/constant-time comparison helpers. No cryptographic algorithms are authored
here. Node HTTP transport is unavailable explicitly; FileStorage is unused.
All executable code is bundled locally. Transitive package licenses are included
in the generated artifact.

Receiving uses LINEJS's request/response `talk.sync()` API, not its indefinitely
streaming duplex PUSH transport. Preserve the upstream 180-second SYNC deadline;
the browser transport has a 195-second outer ceiling, and Stop cancels immediately.
Do not shorten a long poll to the ordinary 30-second API timeout or hide actual
timeouts as successful idle polls. No automatic password login, send retry or
external logging runs. LINEJS log events are not subscribed to because those
may contain credentials and decrypted payloads.

## Independent live test environment

```sh
pnpm test:line-personal-live
```

This optional local runner creates a **new** QR-authorized in-memory LINE
session. It never reads, exposes or controls an installed Chrome extension's
page, session or credentials. It executes the same browser-bundled base client
and crypto facade inside a VM with code generation disabled, using Node fetch
restricted to the two LINE origins and disallowing redirects.

The user scans `tmp/line-personal-live-case/qr.png` and enters the temporary PIN
from `pin.txt` if requested. Authentication may require reauthorizing another
secondary client later; coexistence is not assumed. QR and PIN files are deleted
after login or shutdown. Session tokens and E2EE keys are never written to disk.
The runner expires after 15 minutes; Ctrl+C also aborts requests and discards it.

The user's authorized OA must send the exact unique challenge in `test-case.json`
to the connected personal account. Only a fresh direct-to-self message matching
that challenge triggers one reply, to the incoming sender, with the exact
`reply` text from that file. OA mode is selected in advance. Other messages are
neither exposed nor acted on; duplicate challenges and uncertain results never
cause a retry. `state.json` retains sanitized counters and the final outcome.
Use the authorized Admin conversation to verify the reply independently.

The runner can verify protocol behavior and an OA roundtrip without reading a
blocked extension page. It **does not prove** Chrome CORS, browser header behavior,
real extension CSP or the installed extension's runtime state.

## Evidence and remaining gates

- Offline: browser-context initialization with string/wasm code generation
  disabled, RFC 5869 HKDF vector, media ciphertext parity against native crypto,
  media roundtrip and tamper rejection; actual LINEJS encrypted text send
  decrypted independently with native X25519/AES-GCM; unsupported E2EE peer
  rejection before dispatch; staged send outcomes and one-time challenge binding.
- UI: generated connection page inspected in Chrome while disconnected.
- Pending: actual extension CSP and network permissions, QR/PIN login, encrypted
  direct/group receive/send, browser header compatibility, real attachment
  transfer/decryption, reconnect and coexistence with official LINE clients.
- A bundled media roundtrip proves crypto compatibility only. Receiving a media
  operation in the probe does not establish attachment download/decryption.

After this gate passes, continue the existing provider adapter/facade and mapper
implementation. Reuse the existing Omnichat ingress and workers; preserve
`line` (database OA), `line_oa` (Omnichat OA), and add `line_personal` separately.
Keep the existing 10-conversation / 25-message bootstrap cap and automation rules.
