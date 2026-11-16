import { BaseClient } from "@evex-dev/linejs/base";
import { createBrowserFetch } from "./line-personal-fetch.js";

/** A scoped transport view of the existing authorized session, not a new login.
 * Poll/history retain their own requests when an individual reply expires. */
export function personalCommandClient(base, signal) {
  const client = new BaseClient({ device: base.device, storage: base.storage, fetch: createBrowserFetch(signal) });
  Object.defineProperty(client, "authToken", { get: () => base.authToken, set: (token) => { base.authToken = token; } });
  client.profile = base.profile;
  client.getReqseq = base.getReqseq.bind(base);
  client.on("update:authtoken", (token) => { base.emit("update:authtoken", token); });
  return client;
}
