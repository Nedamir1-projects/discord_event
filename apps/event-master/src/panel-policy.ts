import { isAdmin } from '@discord-bots/shared';

export interface PanelSessionPolicy {
  ownerId: string;
  expiresAt: number;
}

export function canUsePanel(
  actorId: string,
  adminIds: string,
  session: PanelSessionPolicy | undefined,
  now = Date.now(),
): boolean {
  return Boolean(
    session &&
    session.expiresAt >= now &&
    session.ownerId === actorId &&
    isAdmin(actorId, adminIds),
  );
}
