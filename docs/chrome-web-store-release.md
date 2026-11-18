# Automated Chrome Web Store releases

Merging an increase to `extension/manifest.json` into `main` automatically
queues `Publish Chrome extension`. The queue job dispatches the existing release
job with the new version using GitHub's short-lived repository token. The release
job checks out the dispatch's immutable `main` commit, verifies the manifest
version, builds and saves the ZIP, obtains a short-lived Google access token, and
submits the ZIP for review. Google publishes approved submissions using the
item's existing visibility.

## One-time account setup

A Google Cloud administrator must choose the project and authorize this setup.
The repository does not contain a project ID, account key or refresh token.
Enable Chrome Web Store API, IAM, IAM Credentials and Security Token Service in
that project. Create a dedicated `cws-publisher` service account with no project
roles. In Chrome Web Store Developer Dashboard → Account, link its email to the
publisher that owns Omnichat. Google currently permits one linked service account
per publisher; reuse/reconcile an existing link rather than replacing it blindly.
The link grants authority over that publisher's items, not just this repository.

Use GitHub OIDC → Workload Identity Federation → that service account. No JSON
key is needed. The following commands are a setup template for an authorized
operator with `gcloud` and `gh`; fill in the project ID, then review the target
before running the mutation commands. They create new resources; if resources
already exist, inspect and reuse them instead of rerunning creation.

```sh
CWS_PROJECT_ID='YOUR_PROJECT_ID'
CWS_REPO='kaojai-ai/omnichat-bridge'
CWS_REPO_ID=$(gh api "repos/$CWS_REPO" --jq .id)
CWS_PROJECT_NUMBER=$(gcloud projects describe "$CWS_PROJECT_ID" --format='value(projectNumber)')
CWS_ACCOUNT="cws-publisher@$CWS_PROJECT_ID.iam.gserviceaccount.com"
CWS_POOL='omnichat-publishing'
CWS_PROVIDER='github'

gcloud services enable chromewebstore.googleapis.com iam.googleapis.com iamcredentials.googleapis.com sts.googleapis.com --project="$CWS_PROJECT_ID"
gcloud iam service-accounts create cws-publisher --display-name='Chrome Web Store publisher' --project="$CWS_PROJECT_ID"
gcloud iam workload-identity-pools create "$CWS_POOL" --location=global --display-name='Omnichat publishing' --project="$CWS_PROJECT_ID"
gcloud iam workload-identity-pools providers create-oidc "$CWS_PROVIDER" \
  --project="$CWS_PROJECT_ID" --location=global --workload-identity-pool="$CWS_POOL" \
  --issuer-uri='https://token.actions.githubusercontent.com' \
  --attribute-mapping='google.subject=assertion.sub,attribute.repository_id=assertion.repository_id' \
  --attribute-condition="assertion.repository_id=='$CWS_REPO_ID' && assertion.ref=='refs/heads/main' && assertion.workflow_ref=='$CWS_REPO/.github/workflows/chrome-web-store.yml@refs/heads/main' && assertion.event_name=='workflow_dispatch'"
gcloud iam service-accounts add-iam-policy-binding "$CWS_ACCOUNT" \
  --project="$CWS_PROJECT_ID" --role='roles/iam.workloadIdentityUser' \
  --member="principalSet://iam.googleapis.com/projects/$CWS_PROJECT_NUMBER/locations/global/workloadIdentityPools/$CWS_POOL/attribute.repository_id/$CWS_REPO_ID"
```

Confirm the actual publisher and Store item ID in the Developer Dashboard.
An unpacked development extension ID may differ from the Store item ID.
Add these **repository variables** (not secrets) in GitHub Settings → Secrets and
variables → Actions → Variables:

| Variable | Value |
| --- | --- |
| `CWS_PUBLISHER_ID` | Publisher ID shown in the Store dashboard |
| `CWS_EXTENSION_ID` | Existing Omnichat Store item ID (32 letters a–p) |
| `CWS_SERVICE_ACCOUNT` | Dedicated publisher service-account email |
| `CWS_WORKLOAD_IDENTITY_PROVIDER` | `projects/PROJECT_NUMBER/locations/global/workloadIdentityPools/omnichat-publishing/providers/github` |

The workflow requests only the `chromewebstore` OAuth scope. Do not add project
Editor/Owner or export a service-account key. It creates no credential files;
the downloadable artifact contains only the built extension and bundled notices.

## Submit a release

Merge the extension change with its manifest patch bump. The version must be
higher than the previously uploaded Store version. For a manual retry, dispatch
from `main`:

```sh
gh workflow run chrome-web-store.yml --repo kaojai-ai/omnichat-bridge --ref main -f version=1.0.12
```

Replace the version with the intended manifest version. The workflow refuses a
mismatch or non-main ref. If a newer version reaches `main` before dispatch, the version check rejects the
superseded release. A run's summary records the source SHA, ZIP checksum,
and returned Store submission state. `PENDING_REVIEW` means submitted, not live.
The ZIP is retained as a GitHub Actions artifact even if authentication or
submission later fails. Concurrent submissions are serialized.

Only upload processing is polled, for at most 150 seconds. Review/publication is
asynchronous and can be checked in the Developer Dashboard or with API v2
`fetchStatus`. Upload and publish mutations are never automatically retried.
After an uncertain timeout, inspect Store status/version before dispatching again.
If an earlier submission is under review, resolve it in the existing release
process; this workflow does not cancel or replace it automatically. Visibility
changes may require one manual dashboard publication before API use resumes.

## References

- [Google API release workflow](https://developer.chrome.com/docs/webstore/using-api)
- [Publisher service-account linking](https://developer.chrome.com/docs/webstore/service-accounts)
- [GitHub keyless Google authentication](https://github.com/google-github-actions/auth)
