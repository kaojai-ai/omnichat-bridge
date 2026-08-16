function record(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

function string(value) {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

function timestamp(value, fallback) {
  if (typeof value === "string" && !Number.isNaN(Date.parse(value))) return new Date(value).toISOString();
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return fallback;
  const milliseconds = numeric > 10_000_000_000_000
    ? numeric / 1_000_000
    : numeric < 10_000_000_000 ? numeric * 1000 : numeric;
  const parsed = new Date(milliseconds);
  return Number.isNaN(parsed.getTime()) ? fallback : parsed.toISOString();
}

function textContent(value) {
  if (typeof value === "string") return value;
  return string(record(value)?.text) ?? "";
}

function contentRecord(value) {
  const direct = record(value);
  if (direct) return direct;
  if (typeof value !== "string") return null;
  try { return record(JSON.parse(value)); } catch { return null; }
}

const SHOPEE_LEGACY_VIDEO_CDN_ORIGIN = "https://down-tx-sg.vod.susercontent.com/";
const SHOPEE_VIDEO_PLAYER_ORIGIN = "https://down-ws-sg.vod.susercontent.com";

function isShopeeVideoPlayerUrl(value) {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:"
      && parsed.hostname === "down-ws-sg.vod.susercontent.com"
      && /^\/api\/v4\/\d+\/mms\/[^/]+\.default\.mp4$/i.test(parsed.pathname);
  } catch {
    return false;
  }
}

function shopeeVideoPlayerUrl(value) {
  const raw = string(value);
  if (!raw) return null;
  const mediaKey = raw.replace(/^\/+/, "").replace(/\.default\.mp4$/i, "");
  const match = mediaKey.match(/^th-(\d+)-[A-Za-z0-9_-]+$/);
  if (!match) return null;
  return `${SHOPEE_VIDEO_PLAYER_ORIGIN}/api/v4/${match[1]}/mms/${encodeURIComponent(mediaKey)}.default.mp4`;
}

function httpsUrl(value, type) {
  const raw = string(value);
  if (!raw) return null;
  if (type === "video") {
    const playerUrl = shopeeVideoPlayerUrl(raw);
    if (playerUrl) return playerUrl;
  }
  const normalized = raw.startsWith("//")
    ? `https:${raw}`
    : raw.includes("://")
      ? raw
      : type === "video"
        ? new URL(raw.replace(/^\/+/, ""), SHOPEE_LEGACY_VIDEO_CDN_ORIGIN).toString()
      : /^[^/?#]+\.[^/?#]+(?:[/?#]|$)/.test(raw)
        ? `https://${raw}`
        : new URL(raw, globalThis.location?.origin ?? "https://seller.shopee.co.th").toString();
  try { return new URL(normalized).protocol === "https:" ? normalized : null; } catch { return null; }
}

function mediaUrl(value, type, depth = 0, seen = new WeakSet()) {
  if (depth > 4) return null;
  const direct = httpsUrl(value, type);
  if (direct) return direct;

  const item = contentRecord(value);
  if (!item || seen.has(item)) return null;
  seen.add(item);

  const urlKeys = type === "image"
    ? ["image_url", "imageUrl", "media_url", "mediaUrl", "url"]
    : type === "video"
      ? ["vid", "video_id", "videoId", "video_url", "videoUrl", "media_url", "mediaUrl", "url"]
      : type === "sticker"
        ? ["sticker_url", "stickerUrl", "sticker_image", "stickerImage", "image_url", "imageUrl", "media_url", "mediaUrl", "thumbnail_url", "thumbnailUrl", "resource_url", "resourceUrl", "file_url", "fileUrl", "url", "src"]
      : [];
  let fallback = null;
  for (const key of urlKeys) {
    const url = httpsUrl(item[key], type);
    if (!url) continue;
    if (type === "video" && isShopeeVideoPlayerUrl(url)) return url;
    fallback ??= url;
  }

  const nestedKeys = type === "image"
    ? ["image", "image_info", "imageInfo", "media", "attachment", "content", "data"]
    : type === "video"
      ? ["video", "video_info", "videoInfo", "media", "attachment", "content", "data"]
      : type === "sticker"
        ? ["sticker", "sticker_info", "stickerInfo", "sticker_data", "stickerData", "image", "image_info", "imageInfo", "media", "attachment", "content", "data", "payload", "metadata"]
      : [];
  for (const key of nestedKeys) {
    const url = mediaUrl(item[key], type, depth + 1, seen);
    if (!url) continue;
    if (type === "video" && isShopeeVideoPlayerUrl(url)) return url;
    fallback ??= url;
  }
  return fallback;
}

function stickerCdnUrl(content) {
  const stickerId = string(content?.sticker_id);
  const packageId = string(content?.sticker_package_id);
  const format = string(content?.format)?.toLowerCase() ?? "png";
  if (!stickerId || !packageId || !/^[a-z0-9]{1,10}$/.test(format)) return null;
  return `https://deo.shopeemobile.com/shopee/shopee-sticker-live-th/packs/${encodeURIComponent(packageId)}/${encodeURIComponent(stickerId)}@1x.${format}`;
}

function messageType(value) {
  const raw = string(value)?.toLowerCase() ?? "unknown";
  if (raw === "text" || raw === "image" || raw === "video" || raw === "sticker" || raw === "product") return { type: raw };
  if (/(sticker|emoji)/.test(raw)) return { type: "sticker" };
  return { type: "unsupported", provider_type: raw };
}

function candidates(value, output = [], depth = 0, seen = new WeakSet()) {
  if (depth > 7 || !value || typeof value !== "object" || seen.has(value)) return output;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) candidates(item, output, depth + 1, seen);
    return output;
  }
  if ((string(value.id) || string(value.message_id)) && string(value.conversation_id)) output.push(value);
  for (const child of Object.values(value)) candidates(child, output, depth + 1, seen);
  return output;
}

function parseShopeeMessages(payload, captureMethod) {
  const observedAt = new Date().toISOString();
  const results = [];
  const seen = new Set();
  for (const message of candidates(payload)) {
    const id = string(message.id) ?? string(message.message_id);
    const conversationId = string(message.conversation_id);
    const senderId = string(message.from_id);
    const recipientId = string(message.to_id);
    const senderAccountId = string(message.from_shop_id);
    const recipientAccountId = string(message.to_shop_id);
    const content = contentRecord(message.content);
    const providerAccountId = recipientAccountId
      ?? senderAccountId
      ?? string(message.shop_id)
      ?? string(content?.shop_id);
    const parsedType = messageType(message.type ?? message.message_type);
    const text = parsedType.type === "product"
      ? string(content?.product_name) ?? ""
      : textContent(message.content);
    const clientMessageId = string(content?.uid);
    const contentUrl = mediaUrl(message.content, parsedType.type);
    const messageUrl = mediaUrl(message, parsedType.type);
    const url = parsedType.type === "video"
      ? [contentUrl, messageUrl].find(isShopeeVideoPlayerUrl) ?? contentUrl ?? messageUrl
      : contentUrl
        ?? (parsedType.type === "sticker" ? stickerCdnUrl(content) : null)
        ?? messageUrl;
    if (!id || !conversationId || !senderId || !recipientId || (parsedType.type === "text" && (!text || text.length > 20_000))) continue;
    const key = `${conversationId}:${id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    results.push({
      provider: "shopee",
      conversation_id: conversationId,
      id,
      event_timestamp: timestamp(message.created_timestamp ?? message.created_at ?? message.timestamp, observedAt),
      observed_at: observedAt,
      sender_id: senderId,
      recipient_id: recipientId,
      ...(providerAccountId ? { provider_account_id: providerAccountId } : {}),
      ...(senderAccountId ? { sender_account_id: senderAccountId } : {}),
      ...(recipientAccountId ? { recipient_account_id: recipientAccountId } : {}),
      type: parsedType.type,
      ...(text && text.length <= 20_000 ? { text } : {}),
      ...(clientMessageId ? { client_message_id: clientMessageId } : {}),
      ...(url ? { media_url: url } : {}),
      ...(parsedType.type === "product" && string(content?.product_id)
        ? {
          product: {
            provider_product_id: string(content.product_id),
            product_name: string(content.product_name) ?? "Product",
            ...(string(content.shop_id) ? { provider_account_id: string(content.shop_id) } : {}),
          },
        }
        : {}),
      ...(parsedType.provider_type ? { provider_type: parsedType.provider_type } : {}),
      capture_method: captureMethod
    });
  }
  return results;
}

globalThis.OmnichatShopee = { parseShopeeMessages };
