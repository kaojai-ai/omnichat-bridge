# Omnichat Bridge

For a normal user-authorized merge, unless the user specifies otherwise:

1. For extension releases, include a patch bump in `extension/manifest.json` and merge using the shared KJ SLDC workflow. Merging the version bump into `main` automatically queues Chrome Web Store submission for review.
2. After merging, update the clean canonical main checkout to the merged `origin/main` and run `pnpm build` there. Preserve unrelated work; if the checkout cannot be safely updated, report the blocker rather than overwriting it.
3. Give the user both the unpacked `tmp/extension` directory for local installation and a ZIP of the built extension for Chrome Web Store submission. Package the contents of the build, including its bundled client and notices; do not use raw source as the store artifact.

Report merge, submission, and Store publication separately. Use manual dispatch only when needed. See [Chrome Web Store releases](docs/chrome-web-store-release.md).
