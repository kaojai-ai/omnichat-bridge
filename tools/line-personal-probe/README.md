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
streaming duplex PUSH transport. No automatic password login, send retry or
external logging runs. LINEJS log events are not subscribed to because those
may contain credentials and decrypted payloads.

## Evidence and remaining gates

- Offline: browser-context initialization with string/wasm code generation
  disabled, RFC 5869 HKDF vector, media ciphertext parity against native crypto,
  media roundtrip and tamper rejection.
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
