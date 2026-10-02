# LINE OA attachments through KaoJai

KaoJai Admin uploads attachments through its existing media pipeline. The send-message worker dispatches a media URL over the Omnichat WebSocket to the selected browser. The extension downloads bytes only from the account's configured HTTPS `image_server_url` origin and uploads them using the signed-in LINE OA session. Credentials remain in that browser.

LINE OA's current browser client uploads multipart `file` data to `/api/v1/bots/{botId}/messages/{chatId}/uploadFile`. It receives `contentMessageToken`, then posts `{items: [{sendId, contentMessageToken}]}` to `/api/v1/bots/{botId}/chats/{chatId}/messages/bulkSendFiles`. Images use this flow too; KaoJai media URLs are not substituted into a LINE message payload.

This contract was inspected in LINE's public `cms.DwkJzN5V.js` asset, loaded by the authenticated chat page on 2026-10-02. It is an internal browser interface and may change. The extension uses the browser's cookies and the existing chat-client-version header. Failed uploads and missing tokens stop before message submission.

Supported bridge commands: `send_image`, `send_video`, and `send_file`, alongside text and stickers. The extension advertises these capabilities per accessible account; older extensions are excluded from video/file dispatch. File commands retain the original filename. Images accept JPEG, PNG, and GIF; videos accept MP4, MOV, M4V, and AVI MIME types. LINE validates uploaded content and may reject additional file types.

Bridge limits are 20 MiB for images and 32 MiB for videos/files. The latter is intentionally below LINE's observed 100 MiB limit to bound memory and the base64 Chrome-extension message payload. This implementation transfers one attachment at a time and retains the existing synchronous delivery model.

The worker waits up to 25 seconds for attachment results, bounded by the caller's remaining provider deadline. The command carries its absolute deadline. The extension checks that deadline before uploading and again before submitting the returned token. An upload failure is unsent; a network failure after submission or an accepted send without a confirmed message ID is uncertain. There is no automatic resend after an uncertain result. History matching uses the caller's send ID.

Rollout requires server support before extension version 0.6.44 is distributed. Existing configurations must include the media origin in `image_server_url`; accounts with missing or mismatched media origins reject attachments. Changing code does not update installed extensions or deploy the server.

Validation uses mocked provider requests, decoded-byte transport tests, capability/tenant gating tests, and worker type checks. Live delivery from Admin, large-file behavior, LINE processing time, and store publication require separate verification. Do not use customer conversations for test sends without explicit authorization.

Durable wiki destination after the owning changes reach remote main: `kj-wiki/content/areas/build/feature-spec/chat/admin-chat-v2-unified-inbox/chat-delivery-and-provider-health.md`. Record both source PRs/merged commits, actual release status, limits, and verified delivery evidence.
