---
type: reference
status: planned
---

# Shopee routing and video release candidate 0.6.63

Source is on a scoped branch; this document does not establish production rollout.

| Layer | Check | Evidence/status |
|---|---|---|
| Automated extension | Routing, surface priority/recovery, identity isolation, fallback, video protocol, deadlines and no duplicate send | 434 tests passed; popup fixture refresh 14 passed |
| Automated shared contract | Allowed fields, partial values, optional zeros, invalid recipient | 3 parser tests and package build passed |
| Local database | Existing ingestion RPC atomic merge, stale updates, unchanged-row suppression, tenant/shop isolation | Isolated migration applied; SQL regressions passed; schema generated; local DB stopped |
| Automated collector | Existing batches, routing forwarding, malformed optional values | 46 tests and TypeScript passed with published beta |
| Automated worker | Scoped route read, reuse across messages, failure fallback, capability gate, video deadlines | 93 tests, worker-client build and TypeScript passed with published beta |
| Native provider | New Webchat seller video protocol | Upload/report/status/message requests inspected; native video reached buyer |
| Native provider | Safari buyer text/image/video to seller | Seller receipts observed |
| Extension live | Updated existing unpacked installation | Source path inspected, existing configuration preserved, version 0.6.63 reloaded |
| Extension live | Text using supplied command routing | Page bridge returned success with provider message ID; buyer receipt observed |
| Extension live | Image/video via extension command, empty-cache bypass and fallback warnings | Pending; Chrome control was repeatedly interrupted by another window/session |
| Extension live | Background recovery/focus behavior | Automated coverage passed; live recovery pending |
| Mini-chat video | Capability | Unsupported and rejected before upload; not advertised |
| KaoJai end-to-end | Saved DB routing matches actual worker command; forwarded inbound media capture | Pending authorized migration/deployment and end-to-end run |

Live extension text was injected through the existing page bridge command handler;
it does not prove the deployed KaoJai worker issued that command. No credential-bearing
HAR was exported. Authentication, cookies and upload grants stay in the browser.

Rollout dependencies: db-contracts PR571 → collector PR194 / stateless-apps PR378 →
extension. Contracts beta 0.1.1720-beta.omnichat.2 is published; consumer PRs remain
draft until the shared contract merges, stable package is published and beta pins
are replaced. No production migration, deployment or merge was performed.

MVP: routing travels with forwarded message batches. Conversations without saved
routing keep cache/lookup fallback. This does not guarantee resolution of every
Shopee param_error. Native sends are single-attempt, including timeout or uncertain
acceptance; changing surfaces is never an automatic retry.
