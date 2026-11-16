import { STORAGE, hasLocalConsent, readStorage, writeStorage } from "./storage.js";

// Reuse the popup's disclosure and branding so both entry points show one policy.
export async function initializeConnectionPage({ onConsentRevoked }) {
  const response = await fetch(chrome.runtime.getURL("popup.html"));
  if (!response.ok) throw new Error("Could not load the connection page.");
  const popup = new DOMParser().parseFromString(await response.text(), "text/html");
  const main = document.querySelector("main");
  const connection = document.querySelector("#personal-connection");
  const header = document.importNode(popup.querySelector(".brand"), true);
  header.querySelector(".header-actions").remove();
  header.querySelector("#config-file").remove();
  const settings = document.createElement("a");
  settings.href = "popup.html"; settings.className = "connection-settings"; settings.textContent = "Settings";
  header.append(settings);
  const consent = document.importNode(popup.querySelector("#consent-screen"), true);
  const footer = document.importNode(popup.querySelector("footer"), true);
  footer.querySelector("#update-extension").remove();
  main.prepend(header, consent);
  main.append(footer);
  for (const node of [header.querySelector("#node-version"), footer.querySelector("#version")]) {
    node.textContent = `v${chrome.runtime.getManifest().version}`;
  }
  const checkbox = consent.querySelector("#consent");
  const proceed = consent.querySelector("#continue");
  const back = consent.querySelector("#close-privacy");
  let accepted = false;
  function render(privacy = false) {
    consent.hidden = accepted && !privacy;
    connection.hidden = !consent.hidden;
    checkbox.closest("label").hidden = accepted;
    proceed.hidden = accepted;
    proceed.disabled = !checkbox.checked;
    back.hidden = !accepted;
  }
  async function refreshConsent() {
    const stored = await readStorage([STORAGE.consent]);
    const previous = accepted;
    accepted = hasLocalConsent(stored[STORAGE.consent]);
    if (previous && !accepted) onConsentRevoked();
    render();
    return accepted;
  }
  checkbox.addEventListener("change", () => { proceed.disabled = !checkbox.checked; });
  proceed.addEventListener("click", async () => {
    if (!checkbox.checked) return;
    try {
      await writeStorage({ [STORAGE.consent]: { policy_version: 2, accepted_at: new Date().toISOString() } });
      await refreshConsent();
    } catch {
      consent.querySelector("#consent-error").textContent = "Could not save consent. Please try again.";
    }
  });
  footer.querySelector("#open-privacy").addEventListener("click", () => render(true));
  back.addEventListener("click", () => render());
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes[STORAGE.consent]) void refreshConsent();
  });
  await refreshConsent();
  return refreshConsent;
}
