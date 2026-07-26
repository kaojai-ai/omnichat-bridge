# Privacy Policy

_Last updated: July 26, 2026_

Omnichat Browser Bridge is an open-source Chrome extension. It bridges a
provider chat open in the user's browser with the HTTPS or WSS server that the
user configures. This policy describes the extension's own handling of data.

## Data the extension handles

With the user's explicit in-extension consent, the extension handles only the
data needed to provide its bridge function:

- provider account and customer display names, profile identifiers, avatars,
  and provider account IDs;
- chat messages, message timestamps, message IDs, and supported media links;
- provider-page activity needed to detect supported chat events; and
- the user's bridge configuration, consent record, sync cursor, local delivery
  queue, and safe operational logs.

The extension uses this data only to sync supported chat events, avoid sending
duplicates, show status to the user, and send user-authorized commands through
the open provider chat.

## Where data goes

Chat data is sent only to the HTTPS or WSS destination server explicitly
configured by the user. The extension signs its requests with the locally
stored HMAC secret. It does not send that secret to the configured server as
message data.

If the user adds an optional `logs_url`, the extension also sends sanitized
operational logs to that configured HTTPS destination in signed batches.
Upload starts only after the user selects **Sync messages**.
These logs describe extension lifecycle, provider readiness, sync progress,
queue counts, delivery status, and errors. They do not include chat content,
provider credentials, cookies, login tokens, request headers, HMAC secrets,
or full request URLs.

The project developer does not operate a central service that receives chat
data. The owner of the configured destination server controls its retention,
access, and privacy practices.

## What the extension does not collect

The extension does not collect or transfer provider passwords, cookies, login
tokens, browser credentials, payment information, health information, location,
or browsing history. It does not sell user data, use it for advertising, or use
it for creditworthiness or lending decisions.

## Storage and deletion

The extension stores its configuration, a small temporary delivery queue, and
operational logs in Chrome's local extension storage on the user's device.
Operational logs expire after 48 hours and are also capped to stay within
Chrome storage limits. Users can delete all local configuration, consent,
queued data, cursors, and logs from the extension settings, or remove the
extension. Queued data is removed after a successful delivery where supported
by the configured destination.

## Consent and choices

The extension requires an explicit checkbox consent before it starts syncing.
Users may decline consent, delete all local extension data, or remove the
extension at any time. Use the extension only with provider accounts and data
the user is authorized to access.

## Provider rules

Omnichat Browser Bridge is not affiliated with or endorsed by Shopee, LINE, or
any other provider. Browser-assisted access may conflict with provider terms
or cause warnings, restrictions, or suspension. The account owner accepts that
risk and is responsible for evaluating the applicable rules and laws.

## Changes and contact

We will update this policy when the extension's data practices change. The
current source and issue tracker are available at
<https://github.com/kaojai-ai/omnichat-bridge>.
