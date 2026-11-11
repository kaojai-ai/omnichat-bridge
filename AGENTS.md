# Omnichat Bridge agent guide

Follow the enclosing workspace instructions and preserve unrelated work.

## Version before merge

- Before merging a PR that changes the shipped extension, bump `version` in
  `extension/manifest.json` on that PR's branch. Use the next available patch
  version unless the change warrants a larger increment.
- Compare with fetched `origin/main` before merge. The PR version must be newer;
  retain an existing valid bump instead of bumping again for every follow-up edit.
- Runtime protocol and injected-page compatibility revisions are separate from
  the installable extension version. Changing them does not replace the manifest
  version bump.
