# LINE OA attachments

Use the [shared setup](setup.md) with `provider: "line_oa"`, a Basic ID, and
version 3. Outgoing attachments require an HTTPS `image_server_url`; the
background worker rejects other origins and redirects before passing decoded
bytes to the LINE page. Provider credentials remain in that page.

## Upload and send

The signed-in page uploads multipart `file` data to
`/api/v1/bots/{botId}/messages/{chatId}/uploadFile`, then submits the returned
`contentMessageToken` in `{items: [{sendId, contentMessageToken}]}` to
`/api/v1/bots/{botId}/chats/{chatId}/messages/bulkSendFiles`.
Images use this flow too. These are internal browser interfaces, not a public
LINE API guarantee; they may change.

| Command | Limit | Accepted content |
| --- | --- | --- |
| `send_image` | 20 MiB | JPEG, PNG, GIF |
| `send_video` | 32 MiB | MP4, MOV, M4V, AVI MIME types |
| `send_file` | 32 MiB | Nonempty bytes and required `file_name`; LINE may reject content. |

Text and stickers are also supported. The page bounds a send to 25 seconds or
the command's earlier `deadline_at_ms`, with individual requests capped at 20
seconds. It checks the deadline before upload and submission. Upload failure
is unsent; failed confirmation after native submission may be uncertain.
Do not automatically resend uncertain results. History uses the send ID to
correlate provider messages.

LINE account metadata is reused for the verified browser session, without a time
expiry. Readiness checks still refresh account access independently of sends.
Authentication failures, navigation, account-access changes, and session resets
invalidate cached verification; sends with missing or invalidated metadata await
a successful account check. Elapsed time alone does not add an account-list
request to the send path.

No captured send-response shape currently qualifies for immediate acceptance.
Successful HTTP responses therefore still require history confirmation by send
ID; an arbitrary response ID is not sufficient. This release does not establish
the one-request send target. Provider error responses are rejected immediately.

Send diagnostics include bounded stage durations, history
request count, and confirmation source. Terminal command logs distinguish socket
submission from unavailable or failed acknowledgement submission; socket
submission does not establish backend receipt. Failed and uncertain outcomes are
retained, while successful terminal diagnostics are sampled.

## Compatibility and validation

The page bridge uses `compatibility_version: 1`; missing compatibility fields
in older scripts default to 1. Diagnostic `bridge_version` changes alone do
not invalidate readiness. Command capabilities still govern available sends.
Refresh LINE tabs after updates to load new page behavior.

Tests cover mocked uploads, byte transport, deadlines, and command results.
Live delivery, large files, server integration, and store publication need
separate verification. Source changes alone do not establish those outcomes.
