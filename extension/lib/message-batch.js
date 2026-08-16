export function participantForBatch(participant) {
  if (!participant || typeof participant !== "object") return null;
  const id = String(participant.id ?? "").trim();
  if (!id) return null;
  const displayName = typeof participant.display_name === "string"
    ? participant.display_name.trim()
    : "";
  const avatarUrl = typeof participant.avatar_url === "string"
    ? participant.avatar_url.trim()
    : "";
  return {
    id,
    ...(displayName ? { display_name: displayName } : {}),
    ...(avatarUrl ? { avatar_url: avatarUrl } : {}),
  };
}
