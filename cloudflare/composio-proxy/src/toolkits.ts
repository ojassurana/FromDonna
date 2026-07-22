/**
 * Default Composio toolkit allowlist for new FromDonna users.
 * Product policy: not the full catalog.
 *
 * Slugs must match Composio Tool Router exactly (validated live against
 * backend.composio.dev / docs.composio.dev/toolkits). Underscore Google names
 * like `google_drive` are INVALID for Drive — prefer no-underscore forms:
 * googledrive, googlecalendar, googleslides, …
 *
 * Suite coverage (only apps that exist in Composio):
 * - Google: mail/drive/calendar/sheets/docs + slides/meet/tasks/contacts/forms/photos/chat
 * - Microsoft: outlook + one_drive + excel + microsoft_teams + onenote + share_point
 * - Not in Composio as standalone toolkits: Word, PowerPoint
 */

/** Canonical Composio toolkit slugs we enable for every new Donna user. */
export const DEFAULT_COMPOSIO_TOOLKITS = [
  // Google Workspace
  "gmail",
  "googledrive",
  "googlecalendar",
  "googlesheets",
  "googledocs",
  "googleslides",
  "googlemeet",
  "googletasks",
  "googlecontacts",
  "googleforms",
  "googlephotos",
  "google_chat",
  // Microsoft 365
  "outlook",
  "one_drive",
  "excel",
  "microsoft_teams",
  "onenote",
  "share_point",
  // Other product apps
  "github",
  "linkedin",
  "dropbox",
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

  google_slides: "googleslides",
  "google-slides": "googleslides",
  slides: "googleslides",

  google_meet: "googlemeet",
  "google-meet": "googlemeet",
  meet: "googlemeet",

  google_tasks: "googletasks",
  "google-tasks": "googletasks",
  tasks: "googletasks",

  google_contacts: "googlecontacts",
  "google-contacts": "googlecontacts",
  contacts: "googlecontacts",

  google_forms: "googleforms",
  "google-forms": "googleforms",
  forms: "googleforms",

  google_photos: "googlephotos",
  "google-photos": "googlephotos",
  photos: "googlephotos",

  googlechat: "google_chat",
  "google-chat": "google_chat",
  chat: "google_chat",

  onedrive: "one_drive",
  "one-drive": "one_drive",

  teams: "microsoft_teams",
  "microsoft-teams": "microsoft_teams",
  ms_teams: "microsoft_teams",

  sharepoint: "share_point",
  "share-point": "share_point",

  "one-note": "onenote",
  one_note: "onenote",

  dropboxsign: "dropbox_sign",
  "dropbox-sign": "dropbox_sign",

  // Intentionally NOT in default (no Composio toolkit or enterprise-only):
  // word, powerpoint, docusign, strava, notion, splitwise
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
