function parseChannelIds(value: string): string[] {
  return value
    .split(',')
    .map((channelId) => channelId.trim())
    .filter(Boolean);
}

export function isVoiceChannelAllowed(
  channelId: string,
  allowedChannelIds: string,
  afkChannelIds: string,
): boolean {
  const allowed = parseChannelIds(allowedChannelIds);
  const afk = parseChannelIds(afkChannelIds);
  return (
    (allowed.includes('*') || allowed.includes(channelId)) &&
    !afk.includes(channelId)
  );
}
