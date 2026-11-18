import { appendFile, readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

// No retries of upload/publish: an interrupted mutation may have succeeded.
export async function publishExtension({ publisherId, extensionId, token, version, zip,
  fetch = globalThis.fetch, sleep = delay }) {
  if (!/^[A-Za-z0-9_-]+$/.test(publisherId ?? "")) throw new Error("Invalid publisher ID");
  if (!/^[a-p]{32}$/.test(extensionId ?? "")) throw new Error("Invalid extension ID");
  if (!token || !version || !zip?.length) throw new Error("Missing token, version or ZIP");
  const item = `publishers/${publisherId}/items/${extensionId}`;
  const api = "https://chromewebstore.googleapis.com";
  const request = async (url, options = {}) => {
    let response;
    try {
      response = await fetch(url, { ...options, headers: { Authorization: `Bearer ${token}`, ...options.headers },
        redirect: "error", signal: AbortSignal.timeout(60_000) });
    } catch {
      throw new Error("Store request outcome unknown. Inspect Store status before retrying; no automatic retry was made.");
    }
    if (!response.ok) throw new Error(`Chrome Web Store API HTTP ${response.status}. Inspect the dashboard for details; no automatic retry was made.`);
    try { return await response.json(); }
    catch { throw new Error("Invalid Store response. Inspect Store status before retrying."); }
  };
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
      version: process.env.EXPECTED_VERSION, zip: await readFile(process.argv[2]) });
    const summary = `Chrome Web Store ${result.version}: ${result.state}. Google review and public rollout are separate from submission.\n`;
    console.log(summary.trim());
    if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, summary);
  } catch (error) {
    // Only local fixed error messages; never print raw API bodies or credentials.
    console.error(error.message);
    process.exitCode = 1;
  }
}
