/** Checks a Discord user ID against the delimited ADMIN_IDS setting. */
export function isAdmin(
  userId: string,
  adminIds = process.env.ADMIN_IDS ?? '',
): boolean {
  return adminIds
    .split(/[\s,;]+/)
    .map((id) => id.trim())
    .filter(Boolean)
    .includes(userId);
}
