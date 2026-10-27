const VERSION = 1;
const ACCOUNT_LIMIT = 1_000;
const INSTALLATION_LIMIT = 5_000;
const MAX_RECORD_BYTES = 2 * 1024 * 1024 - 64; // Leave room for the versioned envelope.
const encoder = new TextEncoder();

function identifier(value, maxBytes = 512) {
  if (typeof value !== "string" && typeof value !== "number") return "";
  const text = String(value).trim();
  return text && encoder.encode(text).length <= maxBytes ? text : "";
}

function displayFields(value) {
  let displayName = typeof value?.display_name === "string" ? value.display_name.trim() : "";
  if (encoder.encode(displayName).length > 256) {
    let bytes = 0;
    let bounded = "";
    for (const character of displayName) {
      bytes += encoder.encode(character).length;
      if (bytes > 256) break;
      bounded += character;
    }
    displayName = bounded;
  }
  let avatarUrl = typeof value?.avatar_url === "string" ? value.avatar_url.trim() : "";
  if (avatarUrl) {
    try {
      const url = new URL(avatarUrl);
      if (url.protocol !== "https:" || url.username || url.password
        || encoder.encode(avatarUrl).length > 2_048) avatarUrl = "";
    } catch { avatarUrl = ""; }
  }
  return {
    ...(displayName ? { display_name: displayName } : {}),
    ...(avatarUrl ? { avatar_url: avatarUrl } : {}),
  };
}

function recordKey(scope, conversationId, customerId) {
  return `${scope.length}:${scope}${conversationId.length}:${conversationId}${customerId}`;
}

// Display metadata is advisory. This cache never stores session or send eligibility.
export function createMetadataCache({
  load,
  save,
  now = Date.now,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  onError = () => {},
} = {}) {
  if (typeof load !== "function" || typeof save !== "function") {
    throw new TypeError("Metadata cache storage is required.");
  }
  const records = new Map();
  const recordBytes = new Map();
  const scopeCounts = new Map();
  let totalBytes = 0;
  let hydration;
  let loadFailure = null;
  let revision = 0;
  let persistedRevision = 0;
  let timer = null;
  let inFlight = null;
  let closed = false;
  let disposal = null;

  function reportError(error) {
    try { Promise.resolve(onError(error)).catch(() => {}); } catch {}
  }

  function trim() {
    const ordered = [...records].reverse().sort((left, right) => right[1].updated_at - left[1].updated_at);
    const counts = new Map();
    let retained = 0;
    let retainedBytes = 0;
    let removed = false;
    for (const [key, record] of ordered) {
      const count = counts.get(record.scope) ?? 0;
      const bytes = recordBytes.get(key);
      if (count >= ACCOUNT_LIMIT || retained >= INSTALLATION_LIMIT
        || retainedBytes + bytes > MAX_RECORD_BYTES) {
        records.delete(key);
        recordBytes.delete(key);
        removed = true;
      } else {
        counts.set(record.scope, count + 1);
        retained += 1;
        retainedBytes += bytes;
      }
    }
    scopeCounts.clear();
    for (const [scope, count] of counts) scopeCounts.set(scope, count);
    totalBytes = retainedBytes;
    return removed;
  }

  function put(key, record) {
    // Serialization measures the storage budget only; never compares display values.
    const bytes = encoder.encode(JSON.stringify(record)).length + 1;
    totalBytes += bytes - (recordBytes.get(key) ?? 0);
    recordBytes.set(key, bytes);
    records.set(key, record);
  }

  function schedule() {
    if (closed || loadFailure || timer !== null || inFlight || revision === persistedRevision) return;
    timer = setTimer(() => {
      timer = null;
      void flush().catch(reportError);
    }, 250);
  }

  function changed() {
    if (closed) return;
    revision += 1;
    schedule();
  }

  function hydrate() {
    if (!hydration) hydration = Promise.resolve().then(load).then((stored) => {
      if (closed) return;
      if (stored?.version !== VERSION || !Array.isArray(stored.records)) return;
      for (const input of stored.records) {
        const scope = identifier(input?.scope, 4_096);
        const conversationId = identifier(input?.conversation_id);
        const id = identifier(input?.id);
        const fields = displayFields(input);
        if (!scope || !conversationId || !id || !Object.keys(fields).length) continue;
        const providerAccountId = identifier(input?.provider_account_id);
        const updatedAt = Number(input.updated_at);
        if (!Number.isFinite(updatedAt) || updatedAt < 0) continue;
        const key = recordKey(scope, conversationId, id);
        const previous = records.get(key);
        if (previous && previous.updated_at >= updatedAt) continue;
        put(key, {
          scope, conversation_id: conversationId, id,
          ...(providerAccountId ? { provider_account_id: providerAccountId } : {}),
          ...fields, updated_at: updatedAt,
        });
        if (!previous) scopeCounts.set(scope, (scopeCounts.get(scope) ?? 0) + 1);
      }
      if (trim()) changed();
    }).catch((error) => {
      if (closed) return;
      // Use memory for this worker lifetime, but never overwrite a cache we could not read.
      loadFailure = error;
      reportError(error);
    });
    return hydration;
  }

  function update(scope, profile, overwrite) {
    if (closed) return null;
    const conversationId = identifier(profile?.conversation_id);
    const id = identifier(profile?.id);
    if (!scope || !conversationId || !id) return null;
    const key = recordKey(scope, conversationId, id);
    const previous = records.get(key);
    // Known complete records do not normalize or compare incoming display values.
    if (!overwrite && previous?.display_name && previous?.avatar_url) return previous;
    const incoming = displayFields(profile);
    const fields = overwrite ? incoming : {
      ...(!previous?.display_name && incoming.display_name ? { display_name: incoming.display_name } : {}),
      ...(!previous?.avatar_url && incoming.avatar_url ? { avatar_url: incoming.avatar_url } : {}),
    };
    if (!Object.keys(fields).length) return previous ?? null;
    const providerAccountId = identifier(profile?.provider_account_id);
    const record = {
      ...previous,
      scope, conversation_id: conversationId, id,
      ...(providerAccountId ? { provider_account_id: providerAccountId } : {}),
      ...fields,
      updated_at: overwrite || !previous ? now() : previous.updated_at,
    };
    // Reinsert so equal timestamps still evict the oldest insertion first.
    if (overwrite) records.delete(key);
    put(key, record);
    if (!previous) scopeCounts.set(scope, (scopeCounts.get(scope) ?? 0) + 1);
    if (records.size > INSTALLATION_LIMIT || scopeCounts.get(scope) > ACCOUNT_LIMIT
      || totalBytes > MAX_RECORD_BYTES) trim();
    changed();
    return record;
  }

  async function enrich(scopeValue, message) {
    if (closed) return message;
    await hydrate();
    if (closed) return message;
    const scope = identifier(scopeValue, 4_096);
    const participant = message?.participant;
    if (!participant || typeof participant !== "object") return message;
    const record = update(scope, { ...participant, conversation_id: message.conversation_id,
      provider_account_id: message.provider_account_id ?? participant.provider_account_id }, false);
    if (!record) return message;
    const { display_name: ignoredName, avatar_url: ignoredAvatar, ...identity } = participant;
    return { ...message, participant: {
      ...identity,
      ...(record.display_name ? { display_name: record.display_name } : {}),
      ...(record.avatar_url ? { avatar_url: record.avatar_url } : {}),
    } };
  }

  async function refresh(scopeValue, profiles) {
    if (closed) return 0;
    await hydrate();
    if (closed) return 0;
    const scope = identifier(scopeValue, 4_096);
    if (!scope || !Array.isArray(profiles)) return 0;
    const refreshed = new Set();
    for (const profile of profiles) {
      if (!Object.keys(displayFields(profile)).length) continue;
      const record = update(scope, profile, true);
      if (record) refreshed.add(recordKey(scope, record.conversation_id, record.id));
    }
    return refreshed.size;
  }

  async function flush() {
    if (closed) return;
    await hydrate();
    if (closed) return;
    if (loadFailure) throw loadFailure;
    if (timer !== null) clearTimer(timer);
    timer = null;
    if (inFlight) return inFlight;
    inFlight = (async () => {
      while (!closed && persistedRevision !== revision) {
        const savingRevision = revision;
        // Snapshot immutable records; later updates replace records rather than mutating them.
        await save({ version: VERSION, records: [...records.values()] });
        persistedRevision = savingRevision;
      }
    })();
    try { await inFlight; } finally { inFlight = null; }
  }

  function dispose() {
    if (disposal) return disposal;
    // Fence callers and queued callbacks before awaiting work already in progress.
    closed = true;
    if (timer !== null) clearTimer(timer);
    timer = null;
    disposal = Promise.allSettled([hydration, inFlight]).then(() => {
      records.clear();
      recordBytes.clear();
      scopeCounts.clear();
      totalBytes = 0;
    });
    return disposal;
  }

  return { enrich, refresh, flush, dispose };
}
