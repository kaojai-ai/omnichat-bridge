const SELLER_CENTRE_SURFACE = "seller-centre";

export function sellerCentreConnectionStatus(live) {
  if (live?.socket !== "connected" || live?.provider_surface !== SELLER_CENTRE_SURFACE) return null;
  if (live.provider_surface_ready === true) {
    return {
      label: "CONNECTED · CHAT READY",
      state: "ready",
      hint: "Seller Centre Chat is ready and syncing can continue automatically.",
    };
  }
  if (live.provider_chat_open === false) {
    return {
      label: "CONNECTED · OPEN CHAT",
      state: "warning",
      hint: "Connected to KaoJai. Open Seller Centre Chat to start syncing.",
    };
  }
  return {
    label: "CONNECTED · INITIALIZING",
    state: "warning",
    hint: "Connected to KaoJai. Seller Centre Chat is initializing.",
  };
}
