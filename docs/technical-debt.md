# Architecture and limitations

Shopee and LINE OA share delivery, configuration, and account isolation.
Adapters own page matching, account IDs, capture, readiness, and native sends.
See [setup](setup.md) and the [wire contract](payload-contract.md).

## Incoming messages

Open provider page → adapter capture/history → local pending queue →
HMAC-signed HTTPS batch → server acknowledgement → queue removal.

Scan cursors describe captured work, not server acceptance. Pending messages
remain until accepted, deduplicated, or explicitly skipped in a complete
acknowledgement. Accounts are partitioned by `provider:provider_account_id`.
A flush sends at most 10 batches; each allows 50 conversations, 100 messages
per conversation, 500 messages total, and a 1 MiB body. Delivery failures retry
queued items without requiring another provider scan.

Chrome local storage holds configuration, consent, installation/device IDs,
queues, checkpoints, recovery state, and operational logs (100 entries, 48
hours). Clearing it loses pending work. Provider login credentials stay in
page memory and are not stored or forwarded by the extension.

## Live replies

The extension requests an HMAC-authenticated ticket at `<api_url>/tickets`,
then connects to the returned WSS URL. `<api_url>/control` handles leader
coordination; `/ping` checks API reachability. Ticket lifetime, server presence
retention, and server request waiting are target-server responsibilities.

Commands use an existing signed-in provider tab; outgoing replies do not
create one. Supported commands:

| Provider | Commands |
| --- | --- |
| Shopee | Text, image, product; text/image may quote a message. |
| LINE OA | Text, image, video, file, sticker. |

Attachments must come from the configured HTTPS `image_server_url` origin.
Shopee images are limited to 10 MiB; LINE limits and upload flow are described
in [LINE attachments](line-oa-attachments.md).

An open socket is transport liveness, not proof the provider can send.
Readiness reports are change-driven. Idle keepalives run every 20 seconds;
connection attempts have bounded timeouts and exponential reconnect backoff.
Commands may carry `deadline_at_ms`. An uncertain result must not trigger a
blind resend. The two-minute in-memory request-result cache is not durable or
an exactly-once guarantee.

## Limitations and validation

- Provider browser interfaces can change without notice.
- No capture occurs while Chrome is closed. Later recovery is best effort.
- Provider media URLs may expire; capture does not archive their bytes.
- Multiple installations have independent capture checkpoints; the server
  must coordinate presence and deduplication.
- Shared signing, acknowledgement, and command contracts need conformance
  checks across extension and server implementations.

Existing tests cover account isolation, configuration, signing, acknowledgement,
recovery, connection races, deadlines, and provider commands. Live release
validation must separately cover both providers, Chrome restart, network loss,
idle/reconnect behavior, incoming replay, and supported outgoing messages.
Record installed extension and server versions separately from source merge or
store approval. Safe diagnostics do not establish a customer incident's cause.

Version breaking contracts and update receivers, fixtures, extension, and
adapters together. Never add provider credentials to payloads or logs.
