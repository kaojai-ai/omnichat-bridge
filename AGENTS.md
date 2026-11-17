# Omnichat Bridge

For a normal user-authorized merge, unless the user specifies otherwise:

1. Bump the patch version in `extension/manifest.json` and include it in the PR, then merge the PR into `main` using the shared KJ SLDC workflow.
2. After merging, update the clean canonical main checkout to the merged `origin/main` and run `pnpm build` there. Preserve unrelated work; if the checkout cannot be safely updated, report the blocker rather than overwriting it.
3. Give the user both the unpacked `tmp/extension` directory for local installation and a ZIP of the built extension for Chrome Web Store submission. Package the contents of the build, including its bundled client and notices; do not use raw source as the store artifact.

A merge and artifact handoff do not authorize submission or publication to the Chrome Web Store. Report those outcomes separately.
