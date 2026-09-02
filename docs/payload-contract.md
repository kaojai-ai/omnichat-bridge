# Payload contract

Provider adapters send `omnichat.message_batch` version 1 to:

The envelope is provider-shaped and the delivery contract is provider-neutral.
The current package ships the `shopee` adapter; other providers can use the
same envelope after their adapter and receiver support are published.

## Configuration envelope

The Bridge accepts configuration version 2 as a shared provider envelope. It
ignores unknown top-level and account fields, and skips accounts whose provider
does not have a registered adapter. It still rejects malformed records and
malformed accounts for a registered provider. Registered adapters own their
provider-specific validation and requested server origins.

For Shopee, `provider`, `provider_account_id`, `events_url`, `commands_url`,
and `hmac_secret` remain required. `image_server_url` and `logs_url` are
optional HTTPS endpoints.

```http
POST /omnichat/events
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
  "extension_version": "0.2.0",
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
`text`, `media_url`, `provider_type`, `command_id`, `client_message_id`.

`capture_method` is one of `network_observer`, `poll`, `realtime_socket`, or
`history_recovery`.

## Signature

The UTF-8 HMAC secret signs:

```text
POST
/omnichat/events
<timestamp>
<nonce>
<sha256-hex-of-exact-body>
```

The server resolves the secret from the provider account ID header, rejects
expired timestamps or reused nonces, and validates that the payload provider
and message participants match that account.

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

While its authenticated realtime transport is active, the extension sends
`omnichat.connection_status` every 20 seconds. Seller Centre uses authenticated
polling; legacy Seller Chat uses its WebSocket. The envelope is provider-neutral:
each provider adapter reports named checks and the common capture, delivery,
sync, and queue timestamps. Shopee currently reports `provider_tab`,
`content_bridge`, `provider_account`, and `provider_realtime`.

```json
{
  "type": "connection_status",
  "schema": "omnichat.connection_status",
  "version": 1,
  "provider": "shopee",
  "provider_account_id": "123456789",
  "installation_id": "22222222-2222-4222-8222-222222222222",
  "device_name": "Front desk MacBook",
  "extension_version": "0.5.24",
  "reported_at": "2026-07-31T00:00:00.000Z",
  "client": {
    "platform": "MacIntel",
    "language": "th"
  },
  "health": {
    "reason_code": "healthy",
    "checks": [
      { "key": "provider_tab", "status": "pass" },
      { "key": "content_bridge", "status": "pass" },
      { "key": "provider_account", "status": "pass" },
      { "key": "provider_realtime", "status": "pass" }
    ],
    "metrics": {
      "provider_tabs": 1,
      "pending_messages": 0
    },
    "last_capture_at": "2026-07-31T00:00:00.000Z",
    "last_delivery_at": "2026-07-31T00:00:01.000Z",
    "last_sync_at": "2026-07-31T00:00:01.000Z",
    "last_error": null
  }
}
```

The server records its own `last_seen_at` and does not trust the client
timestamp for liveness. A connection is stale after 90 seconds without a
heartbeat. Seller Centre surface and capability details remain local to the
extension; the server's strict version 1 envelope receives their result through
the common health checks. Connected and disconnected installation records
expire after seven days. No IP address, browser user agent, cookies, login
tokens, or passwords are included.

## Operational log batch

An account may optionally configure `logs_url`. The extension sends safe
operational metadata to that HTTPS endpoint using the same timestamp, nonce,
provider-account, and HMAC signature headers described above. Uploads are
enabled only after the user clicks **Sync messages**, are best-effort, and do
not block message sync. Saving or importing configuration clears any pending
remote-log outbox so logs are never carried to a newly configured target.

```json
{
  "schema": "omnichat.log_batch",
  "version": 1,
  "batch_id": "33333333-3333-4333-8333-333333333333",
  "installation_id": "22222222-2222-4222-8222-222222222222",
  "provider": "shopee",
  "provider_account_id": "123456789",
  "extension_version": "0.3.1",
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
The extension retains local logs for up to 48 hours, capped at 4,000 records
to stay within Chrome storage limits.

## Limits

- 1 MiB request body
- 50 conversations per batch
- 100 messages per conversation
- 500 messages total
- 20,000 characters per text message
- Five-minute request timestamp window
- 100 operational logs per upload batch
