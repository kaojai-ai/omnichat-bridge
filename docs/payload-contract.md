# Payload contract

Provider adapters send `omnichat.message_batch` version 1 to:

The envelope is provider-shaped, but the current extension and receiver support
`shopee` only.

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

The extension removes messages from its local queue only when the batch ID
matches and accepted plus duplicate messages equals the number sent.

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
