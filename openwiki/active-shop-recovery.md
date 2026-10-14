---
type: Explanation
title: Active-shop connection recovery
description: Planned isolation of Shopee profiles and bounded connection recovery.
created: "2026-10-14T11:22:00+07:00"
updated: "2026-10-14T11:26:44+07:00"
---

# Active-shop connection recovery

**Planned — source under review, not deployed.** Each Chrome profile may import the same configuration for all shops. Live sockets, API pings and leader actions should follow the shop identified by the open Shopee session. Saved configuration is not proof of a live session.

[Shared overview](https://github.com/kaojai-ai/kj-wiki/blob/docs/omnichat-reliability-plan/openwiki/repositories/omnichat-bridge.md) · [Delivery issue](https://github.com/kaojai-ai/backlog/issues/65)

## System flow

```mermaid
sequenceDiagram
    participant S as Shopee chat tab — UPDATE
    participant E as Extension — UPDATE
    participant B as Bridge Lambda — UPDATE logging
    participant D as DynamoDB — UNCHANGED
    E->>S: Chrome message: get_provider_status_v3
    S-->>E: current_provider_account_id and capture freshness
    E->>B: Existing authenticated ticket and WebSocket status
    B->>D: Existing presence contract
    Note over S,E: Bounded requests; only signed-in shop owns a socket
```

## Component changes

| Owner | Before | Planned behaviour |
| --- | --- | --- |
| omnichat-bridge: background | Saved detected shops can all own live connections | Resolve current session; close inactive sockets; retain configuration and queued messages |
| omnichat-bridge: recovery | Retry backoff can hide a recovered tab | Keep health checks running; back off reload attempts only |
| omnichat-bridge: capture | Fetch or JSON parsing can hold the polling lock indefinitely | Bound provider requests to 15 seconds; release lock; ignore completion from an old shop session |
| omnichat-bridge: readiness | Successful list polling can hide message-history failure | Report capture failure and apply existing freshness checks to ready status |
| omnichat-bridge: delivery | Upload can delay watchdog; retry timestamp is not enforced | Bound upload/log requests to 15 seconds; independent transport repair; respect automatic retry time |
| omnichat-bridge: popup | All configured shops can look ready | Show only the signed-in Shopee shop; hide inactive shops; show unknown explicitly |
| stateless-apps: bridge Lambda | Connection log context can use global tenant | Use authenticated ticket tenant context, without new database reads |

## Database and contracts

**Database changes: none.** No tables, indexes, grants, migrations or new infrastructure. Existing HMAC, ticket, message queue and WebSocket contracts remain unchanged. The extension's local `active_in_profile` flag is private browser storage, not a server contract.

Example existing status: `{ "ready": false }` when capture is stale or failed. Existing `current_provider_account_id` identifies the signed-in shop; configured IDs are not substituted when detection is unavailable. A missing session can temporarily show unknown until the tab responds.

## Impact and validation

1. Prevent indefinite stalls and misleading readiness. Tests cover hung fetch/body, recovery during backoff and session changes.
2. Isolate profile ownership. Test switching between two configured shops, retiring predecessor sockets and preserving queued messages.
3. Make support status understandable. Only the signed-in Shopee shop is shown and labelled in English/Thai. LINE retains multiple OA accounts per profile. Already captured queues for inactive shops may finish uploading without accessing those provider sessions.
4. Correct tenant attribution without per-heartbeat logging or new network calls.

No heartbeat frequency increase, provisioned concurrency or warm-up scheduler. Fewer inactive connections should reduce unnecessary traffic, but exact savings require post-release measurement. Provider read/upload deadlines do not retry outgoing customer sends or alter uncertain-send handling.

## Rollout and remaining work

Extension and logging changes are independently compatible; neither requires a schema rollout. Merge and deployment require authorization. Validate the released extension with multiple Chrome profiles sharing config, provider login/switch, tab refresh, failed history reads, and an actual two-hour WebSocket rotation.

The production bridge was observed without APP_ENV/KJ_RUNTIME_ENVIRONMENT even though current Terraform declares them. Reconcile through the existing reviewed infrastructure workflow separately; do not guess environment from a socket URL. No production configuration is changed by this patch.

Heartbeat acknowledgements and half-open socket detection remain phase two. The observed customer disconnect after two hours is not conclusively explained by server logs alone. This patch addresses reproduced failure paths; production resolution must be verified after rollout. Existing send-worker execute/ack budgets stay unchanged.
