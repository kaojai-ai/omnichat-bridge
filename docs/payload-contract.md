# Payload contract

Provider adapters send `omnichat.message_batch` version 1 to the configured
`events_url`.

For setup and a validated version 3 example, see [shared setup](setup.md).

The envelope is provider-shaped and the delivery contract is provider-neutral.
The package ships `shopee` and `line_oa` adapters. Both use the same delivery
envelope; adapters own provider-specific capture and native sending.

## Configuration envelope

The Bridge accepts configuration versions 2 and 3 as a shared provider
envelope. It discards unrecognized top-level and account fields, and skips accounts
whose provider does not have a registered adapter. It still rejects malformed
records and malformed accounts for a registered provider. Registered adapters
own their provider-specific validation and requested server origins.

Version 3 requires every configured provider account to supply `provider`,
`provider_account_id`, `events_url`, `api_url`, and `hmac_secret`. Provider
adapters may require additional provider-specific fields. `api_url` is the
account-scoped HTTPS API base; the extension derives `/ping` for a signed API
reachability check, `/tickets` for live tickets, and `/control` for browser
coordination. `image_server_url` and `logs_url` are optional where the
provider adapter supports them.

The API ping request is a signed `POST` with this body:

```json
{
  "schema": "omnichat.ping",
  "version": 1,
  "provider": "shopee",
  "installation_id": "22222222-2222-4222-8222-222222222222"
}
```

The response is:

```json
{
  "schema": "omnichat.ping_ack",
  "version": 1,
  "ok": true
}
```

The ping is read-only and best-effort. A ping failure does not prevent the
Bridge from forwarding provider events through `events_url`.

Version 2 remains supported for Shopee only; LINE OA requires version 3. It requires
`commands_url` instead of `api_url`; the extension derives a compatible
coordination endpoint from `commands_url`.

```http
POST <events_url>
Content-Type: application/json
X-Omnichat-Provider-Account-Id: <provider account ID>
X-Omnichat-Timestamp: <ISO 8601 timestamp>
X-Omnichat-Nonce: <unique UUID>
X-Omnichat-Signature: <HMAC-SHA256 hex>
```

## Batch

```json
{
  "schema": "omnichat.message_batch",
  "version": 1,
  "batch_id": "11111111-1111-4111-8111-111111111111",
  "installation_id": "22222222-2222-4222-8222-222222222222",
  "provider": "shopee",
  "extension_version": "0.6.51",
  "adapter_version": "shopee-realtime-1",
  "conversations": [
    {
      "id": "conversation-1",
      "participants": [
        {
          "id": "buyer-1",
          "display_name": "Buyer",
          "avatar_url": "https://example.com/avatar.jpg"
        }
      ],
      "messages": [
        {
          "id": "message-1",
          "event_timestamp": "2026-07-23T00:00:00.000Z",
          "observed_at": "2026-07-23T00:00:01.000Z",
          "sender_id": "buyer-1",
          "recipient_id": "seller-user-1",
          "recipient_account_id": "shop-1",
          "type": "text",
          "text": "Hello",
          "capture_method": "realtime_socket"
        }
      ]
    }
  ]
}
```

Optional conversation fields: `open_url`, `participants`.

Optional message fields: `sender_account_id`, `recipient_account_id`,
`text`, `media_url`, `provider_type`, `provider_content`, `command_id`,
`client_message_id`.

`provider_content` is the original provider message body for
`type: "unsupported"`. Receiver retention and size handling are target-server responsibilities.

`capture_method` is one of `network_observer`, `poll`, `realtime_socket`, or
`history_recovery`.

## Signature

The UTF-8 HMAC secret signs:

```text
POST
<request path from events_url>
<timestamp>
<nonce>
<sha256-hex-of-exact-body>
```

The target server owns URL routing and account lookup. The Bridge treats
`events_url` as opaque and does not require a particular provider, tenant, or
account path layout. The receiver validates the signed request against its own
configuration, rejects expired timestamps or reused nonces, and validates that
the message participants match the configured account. Existing installations
continue using their previously configured endpoints.

## Acknowledgement

```json
{
  "schema": "omnichat.message_batch_ack",
  "version": 1,
  "batch_id": "11111111-1111-4111-8111-111111111111",
  "accepted_messages": 1,
  "duplicate_messages": 0
}
```

For a Shopee message where neither side, or both sides, identify the
authenticated Shop, the server logs the malformed message at error level,
skips that message, and continues the rest of the batch. When this happens,
the acknowledgement adds the skipped message references:

```json
{
  "skipped_messages": [
    {
      "conversation_id": "conversation-1",
      "message_id": "message-2",
      "reason": "provider_account_not_participant"
    }
  ]
}
```

The extension removes messages from its local queue only when the batch ID
matches and accepted, duplicate, and skipped messages cover the number sent.

## Connection status

The extension publishes `omnichat.connection_status` when readiness or reported
metadata changes. It evaluates the provider page, logged-in account, bridge,
and capture locally. An open command socket alone does not establish readiness.
See [connection recovery](#connection-recovery-and-deadlines) for transport timing.

```json
{
  "type": "connection_status",
  "schema": "omnichat.connection_status",
  "version": 1,
  "provider": "shopee",
  "provider_account_id": "123456789",
  "installation_id": "22222222-2222-4222-8222-222222222222",
  "device_name": "Front desk MacBook",
  "extension_version": "0.6.51",
  "reported_at": "2026-07-31T00:00:00.000Z",
  "ready": true,
  "reason_code": "healthy",
  "client": { "platform": "mac" },
  "last_sync_at": "2026-07-31T00:00:01.000Z"
}
```

The socket being open is liveness. `reported_at` is not used as a heartbeat.
Target servers should handle `extension_version`, `client.platform`, and `last_sync_at`.
`client.platform` is the Chrome OS name (`mac`, `win`, `linux`, `cros`,
`android`), not a user agent. Older extensions may still send `health.checks`;
the server maps those four results onto `ready` and does not store the checks.
A legacy `health.last_sync_at` is stored as `last_sync_at`. No IP address,
browser user agent, cookies, login tokens, or passwords are included.

## Operational log batch

An account may optionally configure `logs_url`. The extension sends safe
operational metadata to that HTTPS endpoint using the same timestamp, nonce,
provider-account, and HMAC signature headers described above. Uploads are
enabled when sync is initialized (manually or through configured automatic sync), are best-effort, and do
not block message sync. Changing the saved configuration clears any pending
remote-log outbox so logs are never carried to a newly configured target.

```json
{
  "schema": "omnichat.log_batch",
  "version": 1,
  "batch_id": "33333333-3333-4333-8333-333333333333",
  "installation_id": "22222222-2222-4222-8222-222222222222",
  "provider": "shopee",
  "provider_account_id": "123456789",
  "extension_version": "0.6.51",
  "sent_at": "2026-07-26T00:00:00.000Z",
  "logs": [
    {
      "id": "44444444-4444-4444-8444-444444444444",
      "at": "2026-07-26T00:00:00.000Z",
      "level": "info",
      "area": "sync",
      "event": "progress",
      "message": "Sync progress updated.",
      "details": {
        "completed": 4,
        "total": 10
      }
    }
  ]
}
```

Any `2xx` response accepts the log batch. Log records contain fixed event
names, bounded sanitized messages, and scalar operational metadata only.
Sensitive detail keys and values are removed before local storage and upload.
The extension retains local logs for up to 48 hours, capped at 100 records
to stay within Chrome storage limits.

## Limits

- 1 MiB request body
- 50 conversations per batch
- 100 messages per conversation
- 500 messages total
- 20,000 characters per text message
- Target servers must enforce their timestamp window and nonce policy
- 100 operational logs per upload batch

## Connection recovery and deadlines

Each configured provider account has one command socket per extension installation,
shared by its tabs. Startup, tab changes, and recovery checks reuse that account's
connection attempt. Ticket acquisition and socket establishment each have a
10-second limit. Failed attempts use exponential backoff with jitter, capped at
60 seconds; backoff resets after 30 seconds of stable connectivity.

The extension sends `{ "type": "keepalive" }` after 20 seconds without socket
activity. This is transport activity, not a readiness report. Targets should
handle it without persistence or application logging. Readiness remains
change-driven. Browser sleep, extension restart, and hosting connection limits
still require reconnecting.

Commands may optionally include `deadline_at_ms` (Unix milliseconds). Older
extensions may ignore it; updated extensions stop before native sending if the
deadline has expired. An absent deadline preserves legacy behavior. A deadline
or lost response after native dispatch does not prove rejection: existing
`send_result.uncertain` remains the delivery-uncertainty signal. The extension
preserves it across the page/content/background boundaries.

Repeated request IDs within the same running worker share a bounded transient
result cache for two minutes. This cache is not durable across worker restarts
and does not establish exactly-once provider delivery. Target servers must not
blindly resend commands whose acceptance is uncertain.

No new capabilities, response fields, or configuration versions are required
for these lifecycle fixes. A target can continue issuing existing tickets and
handling existing status/result envelopes. Optional deadline support does not
require a particular target product or infrastructure.
