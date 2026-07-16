/**
 * Default Composio toolkit allowlist for new FromDonna users.
 * Product policy: not the full catalog.
 */
export const DEFAULT_COMPOSIO_TOOLKITS = [
  "gmail",
  "google_drive",
  "google_calendar",
  "google_sheets",
  "google_docs",
  "github",
  "notion",
  "linkedin",
  "dropbox",
  "onedrive",
  "sharepoint",
  "docusign",
  "strava",
  "splitwise",
  "outlook",
  "dropbox_sign",
] as const;

export type DefaultToolkit = (typeof DEFAULT_COMPOSIO_TOOLKITS)[number];

export function defaultToolkits(): string[] {
  return [...DEFAULT_COMPOSIO_TOOLKITS];
}

/** Intersect requested toolkits with product allowlist (never expand beyond default). */
export function resolveToolkits(requested?: string[] | null): string[] {
  if (!requested || requested.length === 0) return defaultToolkits();
  const allowed = new Set<string>(DEFAULT_COMPOSIO_TOOLKITS);
  const out = requested.map((t) => t.trim().toLowerCase()).filter((t) => t && allowed.has(t));
  return out.length > 0 ? [...new Set(out)] : defaultToolkits();
}
