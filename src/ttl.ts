/** Session TTL helpers — dogfood default is Until revoke. */

/** ~10 years — effectively until owner Revoke (or end_session). */
export const UNTIL_REVOKE_SEC = 60 * 60 * 24 * 365 * 10;

export function parseMaxTtlSec(raw: unknown, fallback = UNTIL_REVOKE_SEC): number {
  if (raw === undefined || raw === null || raw === "") return fallback;
  if (typeof raw === "string") {
    const s = raw.trim().toLowerCase();
    if (s === "until_revoke" || s === "until-revoke" || s === "revoke" || s === "0") {
      return UNTIL_REVOKE_SEC;
    }
  }
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  if (n <= 0) return UNTIL_REVOKE_SEC;
  // Cap absolute runaway, but allow long dogfood windows
  return Math.min(Math.max(Math.floor(n), 60), UNTIL_REVOKE_SEC);
}

export function parseRequestedTtlSec(raw: unknown, siteMax: number): number {
  if (raw === undefined || raw === null || raw === "") return siteMax;
  if (typeof raw === "string") {
    const s = raw.trim().toLowerCase();
    if (s === "until_revoke" || s === "until-revoke" || s === "revoke" || s === "0") {
      return siteMax;
    }
  }
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return siteMax;
  return Math.min(Math.max(Math.floor(n), 60), siteMax);
}
