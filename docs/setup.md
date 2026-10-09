# Setup: Shopee and LINE OA

Both providers use the same popup and configuration flow.

1. Install the extension from the Chrome Web Store, or enable Developer mode
   at `chrome://extensions` and load the repository's `extension/` folder.
2. Sign in to [Shopee Seller Centre](https://seller.shopee.co.th/) and open its
   Chat panel, or sign in to [LINE OA Chat](https://chat.line.biz/).
3. Open the extension, accept the transfer disclosure, and open **Settings**.
4. Import or paste your server-issued configuration, save it, and allow access
   to the configured server origins. Select **Sync messages** if needed.

Refresh provider tabs after updates when their page scripts need new behavior.
Shopee's content bridge can also reattach without a full page refresh. Chrome
and the relevant signed-in provider page must remain available.

## Configuration

```json
{
  "version": 3,
  "accounts": [
    {
      "provider": "shopee",
      "provider_account_id": "123456789",
      "events_url": "https://your-server.example.com/omnichat/events",
      "api_url": "https://your-server.example.com/omnichat/api",
      "hmac_secret": "replace-with-server-issued-secret"
    },
    {
      "provider": "line_oa",
      "provider_account_id": "@example",
      "events_url": "https://your-server.example.com/omnichat/events",
      "api_url": "https://your-server.example.com/omnichat/api",
      "hmac_secret": "replace-with-server-issued-secret"
    }
  ]
}
```

Replace all examples with values from your server administrator. Each
`provider` / `provider_account_id` pair must be unique and match a detected
account: Shopee uses the Shop ID, LINE uses its Basic ID (normalized with `@`).
Shopee sync uses only the currently signed-in shop; LINE can sync multiple
accessible configured accounts.

| Field | Meaning |
| --- | --- |
| `events_url` | HTTPS batch receiver; its path is server-defined. |
| `api_url` | HTTPS base; the bridge appends `/ping`, `/tickets`, `/control`. |
| `hmac_secret` | Server-issued signing secret, not a provider login token. |
| `image_server_url` | Optional HTTPS media origin; required for outgoing attachments. |
| `logs_url` | Optional HTTPS receiver for sanitized operational logs. |

LINE also preserves optional server-issued `canonical_provider_account_id`,
`bot_id`, `tenant_id`, and `user_id`. Do not substitute these for the Basic ID.
Version 2 is legacy Shopee-only configuration using `commands_url` instead of
`api_url`; LINE requires version 3. Unsupported provider entries are skipped;
malformed supported entries are rejected. Unrecognized fields are discarded.

Optional top-level `history_days` is an integer from 1 to 366.
`history_conversation_ids`, when supplied, must contain unique nonempty strings
and requires `history_days`. Historical capture remains provider-dependent.

Saving/importing replaces the account list. Export includes HMAC secrets;
keep it private and never commit real configuration. See the
[payload contract](payload-contract.md) and [privacy policy](../PRIVACY.md).
