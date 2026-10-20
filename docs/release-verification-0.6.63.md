---
type: reference
status: planned
---

# Shopee routing and video release candidate 0.6.63

Source is on a scoped branch; this document does not establish production rollout.

| Layer | Check | Evidence/status |
|---|---|---|
| Automated extension | Routing, surface priority/recovery, identity isolation, fallback, video protocol, deadlines and no duplicate send | 436 tests passed |
| Automated shared contract | Allowed fields, partial values, optional zeros, invalid recipient | 3 parser tests and package build passed |
| Local database | Existing ingestion RPC atomic merge, stale updates, unchanged-row suppression, tenant/shop isolation | Isolated migration applied; SQL regressions passed; schema generated; local DB stopped |
| Automated collector | Existing batches, routing forwarding, malformed optional values | 46 tests and TypeScript passed with published beta |
| Automated worker | Scoped route read, reuse across messages, failure fallback, capability gate, video deadlines | 93 tests, worker-client build and TypeScript passed with published beta |
| Native provider | New Webchat seller video protocol | Upload/report/status/message requests inspected; native video reached buyer |
| Native provider | Safari buyer text/image/video to seller | Seller receipts observed |
| Extension live | Updated existing unpacked installation | Source path inspected, existing configuration preserved, version 0.6.63 reloaded |
| Extension live | Text using supplied command routing | Page bridge returned success with provider message ID; buyer receipt observed |
| Extension live | Supplied-route image/video commands | Both returned success with provider IDs; Safari buyer receipts observed |
| Extension live | Empty route cache | Cleared cache (0 entries); supplied route sent successfully with 0 lookup pages |
| Extension live | Missing/invalid routing | Distinct warning reasons and both fallback sends succeeded |
| Extension live | Background recovery/focus behavior | Automated coverage passed; live recovery pending |
| Mini-chat video | Capability | Unsupported and rejected before upload; not advertised |
| KaoJai end-to-end | Saved DB routing matches actual worker command; forwarded inbound media capture | Pending authorized migration/deployment and end-to-end run |

Live extension sends were injected through the existing page bridge command handler;
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


Video follow-up: the first live extension upload received HTTP 401 because the
MMS v2 grant was sent encoded. The browser now decrypts it using Web Crypto before
multipart upload, matching the native SDK. A fresh extension video command then
returned success and reached Safari. Upload failure produced no chat send and
was not retried automatically. Regression fixtures contain synthetic encrypted
grants only. No native SDK bundle or real upload grants are shipped.

The video MVP accepts MP4 up to 5 MiB on New Webchat. Larger native videos use a
separate chunked-upload protocol, which is outside this release. Mini-chat video
remains unsupported. Use the refreshed RC2 ZIP; the earlier RC ZIP is superseded.
