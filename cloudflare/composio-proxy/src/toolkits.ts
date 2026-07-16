/**
 * Default Composio toolkit allowlist for new FromDonna users.
 * Product policy: not the full catalog.
 *
 * Slugs must match Composio Tool Router exactly (validated live against
 * backend.composio.dev). Underscore Google names (google_drive) are INVALID.
 * Prefer no-underscore forms: googledrive, googlecalendar, …
 */

/** Canonical Composio toolkit slugs we enable for every new Donna user. */
export const DEFAULT_COMPOSIO_TOOLKITS = [
  "gmail",
  "googledrive",
  "googlecalendar",
  "googlesheets",
  "googledocs",
  "github",
  "notion",
  "linkedin",
  "dropbox",
  "splitwise",
  "outlook",
  "dropbox_sign",
] as const;

export type DefaultToolkit = (typeof DEFAULT_COMPOSIO_TOOLKITS)[number];

/**
 * Aliases → canonical Composio slug.
 * Accept common underscore / marketing names from product docs.
 */
const TOOLKIT_ALIASES: Record<string, string> = {
  google_drive: "googledrive",
  google_drive_api: "googledrive",
  "google-drive": "googledrive",
  drive: "googledrive",
  gdrive: "googledrive",

  google_calendar: "googlecalendar",
  "google-calendar": "googlecalendar",
  calendar: "googlecalendar",

  google_sheets: "googlesheets",
  "google-sheets": "googlesheets",
  sheets: "googlesheets",

  google_docs: "googledocs",
  "google-docs": "googledocs",
  docs: "googledocs",

  dropboxsign: "dropbox_sign",
  "dropbox-sign": "dropbox_sign",

  // Intentionally NOT in default (need project auth configs or invalid):
  // docusign, strava, onedrive, sharepoint
};

export function defaultToolkits(): string[] {
  return [...DEFAULT_COMPOSIO_TOOLKITS];
}

export function canonicalizeToolkit(raw: string): string {
  const t = raw.trim().toLowerCase();
  if (!t) return "";
  return TOOLKIT_ALIASES[t] || t;
}

/** Intersect requested toolkits with product allowlist (never expand beyond default). */
export function resolveToolkits(requested?: string[] | null): string[] {
  if (!requested || requested.length === 0) return defaultToolkits();
  const allowed = new Set<string>(DEFAULT_COMPOSIO_TOOLKITS);
  const out = requested
    .map(canonicalizeToolkit)
    .filter((t) => t && allowed.has(t));
  // Non-empty request that filtered to nothing → fall back to defaults (safe product set)
  return out.length > 0 ? [...new Set(out)] : defaultToolkits();
}
