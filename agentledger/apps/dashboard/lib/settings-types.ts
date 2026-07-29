/** Shared settings types — kept out of 'use client' modules for RSC imports. */

export type IdentityRow = {
  userId: string;
  email: string;
  displayName: string | null;
  apiRole: string;
  role?: string;
  active: boolean;
  source: string;
};

export type InviteRow = {
  inviteId: string;
  email: string;
  apiRole: string;
  status: string;
  expiresAt: string;
  acceptedAt: string | null;
  displayName: string | null;
  invitedByName: string | null;
};

export type AuditRow = {
  id: string;
  at: string;
  actor: string;
  actorEmail: string | null;
  actorDisplayName: string | null;
  action: string;
  object: string;
  detail: Record<string, unknown>;
};
