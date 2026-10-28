import { readFileSync } from "node:fs";
import vm from "node:vm";
import { createSessionEligibility } from "../../extension/lib/session-eligibility.js";
const source = readFileSync(new URL("../../extension/background.js", import.meta.url), "utf8");
export function installProviderPolicy(scope) {
  const defaults = {
    hasRegionalShopeePermission: async () => true,
    lineTabSyncs: new Map(), throwIfSyncCancelled: signal => { if (signal?.aborted) throw Object.assign(new Error("Sync cancelled."), { name: "AbortError" }); },
    providerBridgeChecks: new Map(), providerObservationSequence: 0, providerPolicyObservations: new Map(), providerSessionEpochs: new Map(), providerTabEpochs: new Map(), providerPolicyTabIds: new Map(), providerStatusProbes: new Map(), providerProbeTabs: new Map(), providerPolicyContexts: new Map(),
    sessionEligibility: createSessionEligibility({ setTimer: () => 1, clearTimer: () => {} }),
    providerChatTabs: async () => [{ id: 7 }], updateLiveState: async () => {},
    orderProviderTabs: (_adapter, tabs) => tabs,
    providerTabCanSend: (status, context) => Boolean(status) && status.ok !== false && status.ready !== false
      && (context.adapter.id === "shopee" ? status.current_provider_account_id === context.account.provider_account_id
        : status.account_access_verified === true && status.accessible_account_ids?.includes(context.account.provider_account_id)),
    providerTabHealthy: (status) => Boolean(status) && status.ok !== false && status.ready !== false && status.realtime_connected !== false,
  };
  for (const [key, value] of Object.entries(defaults)) if (!(key in scope)) scope[key] = value;
  vm.runInContext(source.slice(source.indexOf("function providerRecoveryKey("), source.indexOf("function providerRecoveryUrl(")), scope);
  vm.runInContext(source.slice(source.indexOf("function providerSessionEpoch("), source.indexOf("async function lineSessionContexts(")), scope);
  return scope;
}
