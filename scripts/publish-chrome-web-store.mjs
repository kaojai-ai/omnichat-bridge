import { appendFile, readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

function compareVersions(a, b) {
  const parse = value => {
    if (!/^(0|[1-9]\d*)(\.(0|[1-9]\d*)){0,3}$/.test(value ?? "")) throw new Error("Unknown Store version; no mutation permitted.");
    const parts = value.split(".").map(Number);
    if (parts.some(part => part > 65535)) throw new Error("Invalid Store version; no mutation permitted.");
    return Array.from({ length: 4 }, (_, i) => parts[i] ?? 0);
  };
  const left = parse(a), right = parse(b);
  for (let i = 0; i < 4; i++) if (left[i] !== right[i]) return Math.sign(left[i] - right[i]);
  return 0;
}
function revisionVersion(revision) {
  const versions = revision?.distributionChannels?.map(channel => channel.crxVersion);
  if (!versions?.length || versions.some(version => version !== versions[0])) throw new Error("Ambiguous Store revision version; no mutation permitted.");
  compareVersions(versions[0], versions[0]);
  return versions[0];
}

// No retries of cancel/upload/publish: an interrupted mutation may have succeeded.
export async function publishExtension({ publisherId, extensionId, token, version, zip,
  fetch = globalThis.fetch, sleep = delay, log = () => {} }) {
  if (!/^[A-Za-z0-9_-]+$/.test(publisherId ?? "")) throw new Error("Invalid publisher ID");
  if (!/^[a-p]{32}$/.test(extensionId ?? "")) throw new Error("Invalid extension ID");
  if (!token || !version || !zip?.length) throw new Error("Missing token, version or ZIP");
  compareVersions(version, version);
  const item = `publishers/${publisherId}/items/${extensionId}`;
  const api = "https://chromewebstore.googleapis.com";
  const request = async (url, options = {}, empty = false) => {
    let response;
    try {
      response = await fetch(url, { ...options, headers: { Authorization: `Bearer ${token}`, ...options.headers },
        redirect: "error", signal: AbortSignal.timeout(60_000) });
    } catch {
      throw new Error("Store request outcome unknown. Inspect Store status before retrying; no automatic retry was made.");
    }
    if (!response.ok) throw new Error(`Chrome Web Store API HTTP ${response.status}. Inspect the dashboard for details; no automatic retry was made.`);
    if (empty) return;
    try { return await response.json(); }
    catch { throw new Error("Invalid Store response. Inspect Store status before retrying."); }
  };
  const statusUrl = `${api}/v2/${item}:fetchStatus`;
  const inspect = async () => {
    const status = await request(statusUrl);
    if (status.name !== item || status.itemId !== extensionId || status.takenDown || status.warned) {
      throw new Error("Store identity or policy status requires manual inspection; no mutation permitted.");
    }
    if (status.lastAsyncUploadState === "IN_PROGRESS") throw new Error("Another upload is in progress; no mutation permitted.");
    const published = status.publishedItemRevisionStatus;
    if (published && compareVersions(revisionVersion(published), version) > 0) throw new Error("Newer version is already published; no mutation permitted.");
    return status;
  };
  const status = await inspect();
  const published = status.publishedItemRevisionStatus;
  const pending = status.submittedItemRevisionStatus;
  if (published && compareVersions(revisionVersion(published), version) === 0) {
    if (pending) throw new Error("Requested version is published but another submission exists; no mutation permitted.");
    return { version, state: published.state };
  }
  if (pending) {
    const pendingVersion = revisionVersion(pending);
    const comparison = compareVersions(pendingVersion, version);
    if (comparison > 0) throw new Error("Newer Store submission exists; no mutation permitted.");
    if (comparison === 0) {
      if (["PENDING_REVIEW", "STAGED", "PUBLISHED", "PUBLISHED_TO_TESTERS"].includes(pending.state)) return { version, state: pending.state };
      throw new Error("Requested version already exists in Store; inspect before retrying.");
    }
    if (pending.state === "PENDING_REVIEW") {
      // API has no revision-bound cancel precondition. Re-read under the workflow
      // concurrency lock; dashboard/external publishers must not race this release.
      const fresh = await inspect();
      if (JSON.stringify(fresh.submittedItemRevisionStatus) !== JSON.stringify(pending) ||
          JSON.stringify(fresh.publishedItemRevisionStatus) !== JSON.stringify(published)) {
        throw new Error("Store revisions changed before cancellation; no mutation permitted.");
      }
      log(`Replacing older pending Store version ${pendingVersion} with ${version} for ${extensionId}.`);
      await request(`${api}/v2/${item}:cancelSubmission`, { method: "POST" }, true);
      const after = await inspect();
      const remaining = after.submittedItemRevisionStatus;
      if (JSON.stringify(after.publishedItemRevisionStatus) !== JSON.stringify(published) ||
          (remaining && (remaining.state !== "CANCELLED" || revisionVersion(remaining) !== pendingVersion))) {
        throw new Error("Store cancellation not confirmed or revision changed; upload was not called.");
      }
    } else if (!["CANCELLED", "REJECTED"].includes(pending.state)) {
      throw new Error("Store submission is not an older pending review; no mutation permitted.");
    }
  }
  const uploaded = await request(`${api}/upload/v2/${item}:upload`, {
    method: "POST", headers: { "Content-Type": "application/zip" }, body: zip,
  });
  let state = uploaded.uploadState;
  for (let attempt = 0; state === "IN_PROGRESS" && attempt < 30; attempt++) {
    await sleep(5_000);
    state = (await request(`${api}/v2/${item}:fetchStatus`)).lastAsyncUploadState;
  }
  if (state !== "SUCCEEDED") throw new Error(`Upload did not complete successfully (${["IN_PROGRESS", "FAILED", "NOT_FOUND"].includes(state) ? state : "unknown"}); publish was not called.`);
  if (uploaded.crxVersion && uploaded.crxVersion !== version) throw new Error("Uploaded version mismatch; publish was not called.");
  const submission = await request(`${api}/v2/${item}:publish`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ publishType: "DEFAULT_PUBLISH", skipReview: false }),
  });
  if (!["PENDING_REVIEW", "PUBLISHED", "STAGED", "PUBLISHED_TO_TESTERS"].includes(submission.state)) {
    throw new Error("Unexpected submission state. Inspect Store status before retrying.");
  }
  return { version, state: submission.state };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = await publishExtension({ publisherId: process.env.CWS_PUBLISHER_ID,
      extensionId: process.env.CWS_EXTENSION_ID, token: process.env.CWS_ACCESS_TOKEN,
      version: process.env.EXPECTED_VERSION, log: console.log, zip: await readFile(process.argv[2]) });
    const summary = `Chrome Web Store ${result.version}: ${result.state}. Google review and public rollout are separate from submission.\n`;
    console.log(summary.trim());
    if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, summary);
  } catch (error) {
    // Only local fixed error messages; never print raw API bodies or credentials.
    console.error(error.message);
    process.exitCode = 1;
  }
}
