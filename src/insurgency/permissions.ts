// Checks a Discord user ID against an explicit allowlist from config.json.
// Takes a bare ID rather than an interaction so it works the same for both
// slash commands and the status panel's buttons.
export function isUserAllowed(userId: string, allowedUserIds: string[]): boolean {
  return allowedUserIds.includes(userId);
}
