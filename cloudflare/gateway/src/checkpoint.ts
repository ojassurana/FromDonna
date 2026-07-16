/**
 * Channel-agnostic per-user runtime checkpoint storage on R2.
 *
 * Layout:
 *   users/{userId}/checkpoint.tar.gz
 *   users/{userId}/manifests/latest.json
 *
 * Pause/resume does not need this. Used when a runtime is created or replaced.
 */

export interface CheckpointEnv {
  USER_STATE?: R2Bucket;
  WORKER_TO_HARNESS_SECRET: string;
}

export type CheckpointManifest = {
  version: 1;
  userId: string;
  savedAt: string;
  bytes: number;
  sha256?: string;
  runtimeId?: string;
  source?: string;
};

const MAX_CHECKPOINT_BYTES = 40 * 1024 * 1024; // 40 MiB hard cap for Worker body
const CHECKPOINT_OBJECT = (userId: string) => `users/${userId}/checkpoint.tar.gz`;
const MANIFEST_OBJECT = (userId: string) => `users/${userId}/manifests/latest.json`;

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

function requiredSecret(env: CheckpointEnv): string {
  const value = env.WORKER_TO_HARNESS_SECRET;
  if (!value) throw new Error("WORKER_TO_HARNESS_SECRET is missing.");
  return value;
}

/** Constant-time-ish bearer check for internal harness → Worker calls. */
export function authorizeHarness(request: Request, env: CheckpointEnv): boolean {
  const expected = `Bearer ${requiredSecret(env)}`;
  const auth = request.headers.get("authorization") || "";
  if (auth.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= auth.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

function safeUserId(raw: string | null): string | null {
  if (!raw) return null;
  const userId = raw.trim();
  // Product identity, e.g. telegram:123 — not a filesystem path segment abuse.
  if (!userId || userId.length > 200) return null;
  if (userId.includes("..") || userId.includes("/") || userId.includes("\\")) return null;
  if (!/^[a-zA-Z0-9:_@.+-]+$/.test(userId)) return null;
  return userId;
}

async function sha256Hex(data: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function hasCheckpoint(env: CheckpointEnv, userId: string): Promise<boolean> {
  if (!env.USER_STATE) return false;
  const obj = await env.USER_STATE.head(CHECKPOINT_OBJECT(userId));
  return obj !== null;
}

export async function getCheckpointBytes(
  env: CheckpointEnv,
  userId: string,
): Promise<{ bytes: ArrayBuffer; manifest: CheckpointManifest | null } | null> {
  if (!env.USER_STATE) return null;
  const obj = await env.USER_STATE.get(CHECKPOINT_OBJECT(userId));
  if (!obj) return null;
  const bytes = await obj.arrayBuffer();
  let manifest: CheckpointManifest | null = null;
  try {
    const man = await env.USER_STATE.get(MANIFEST_OBJECT(userId));
    if (man) manifest = (await man.json()) as CheckpointManifest;
  } catch {
    manifest = null;
  }
  return { bytes, manifest };
}

export async function putCheckpoint(
  env: CheckpointEnv,
  userId: string,
  body: ArrayBuffer,
  meta?: { runtimeId?: string; source?: string },
): Promise<CheckpointManifest> {
  if (!env.USER_STATE) throw new Error("USER_STATE R2 binding is not configured.");
  if (body.byteLength === 0) throw new Error("empty_checkpoint");
  if (body.byteLength > MAX_CHECKPOINT_BYTES) throw new Error("checkpoint_too_large");

  const hash = await sha256Hex(body);
  const manifest: CheckpointManifest = {
    version: 1,
    userId,
    savedAt: new Date().toISOString(),
    bytes: body.byteLength,
    sha256: hash,
    runtimeId: meta?.runtimeId,
    source: meta?.source || "turn",
  };

  await env.USER_STATE.put(CHECKPOINT_OBJECT(userId), body, {
    httpMetadata: { contentType: "application/gzip" },
    customMetadata: {
      userId,
      sha256: hash,
      bytes: String(body.byteLength),
    },
  });
  await env.USER_STATE.put(MANIFEST_OBJECT(userId), JSON.stringify(manifest), {
    httpMetadata: { contentType: "application/json" },
  });
  return manifest;
}

/**
 * POST /internal/checkpoint
 * Auth: Bearer WORKER_TO_HARNESS_SECRET
 * Header: X-FromDonna-User-Id
 * Body: gzipped tar of agent-home + workspace (filtered)
 */
export async function handleCheckpointUpload(request: Request, env: CheckpointEnv): Promise<Response> {
  if (!authorizeHarness(request, env)) return new Response("Unauthorized", { status: 401 });
  if (!env.USER_STATE) return json({ ok: false, error: "r2_not_configured" }, 503);

  const userId = safeUserId(request.headers.get("x-fromdonna-user-id"));
  if (!userId) return json({ ok: false, error: "invalid_user_id" }, 400);

  const contentType = (request.headers.get("content-type") || "").toLowerCase();
  if (
    contentType &&
    !contentType.includes("application/gzip") &&
    !contentType.includes("application/x-gzip") &&
    !contentType.includes("application/octet-stream")
  ) {
    return json({ ok: false, error: "unsupported_content_type" }, 415);
  }

  const lengthHeader = request.headers.get("content-length");
  if (lengthHeader && Number(lengthHeader) > MAX_CHECKPOINT_BYTES) {
    return json({ ok: false, error: "checkpoint_too_large", maxBytes: MAX_CHECKPOINT_BYTES }, 413);
  }

  const body = await request.arrayBuffer();
  if (body.byteLength === 0) return json({ ok: false, error: "empty_checkpoint" }, 400);
  if (body.byteLength > MAX_CHECKPOINT_BYTES) {
    return json({ ok: false, error: "checkpoint_too_large", maxBytes: MAX_CHECKPOINT_BYTES }, 413);
  }

  try {
    const manifest = await putCheckpoint(env, userId, body, {
      runtimeId: request.headers.get("x-fromdonna-runtime-id") || undefined,
      source: request.headers.get("x-fromdonna-checkpoint-source") || "turn",
    });
    return json({ ok: true, manifest });
  } catch (error) {
    const message = error instanceof Error ? error.message : "checkpoint_failed";
    if (message === "r2_not_configured") return json({ ok: false, error: message }, 503);
    console.error("checkpoint put failed", message);
    return json({ ok: false, error: "checkpoint_failed" }, 500);
  }
}

/**
 * GET /internal/checkpoint/status?userId=
 * Auth: Bearer WORKER_TO_HARNESS_SECRET (ops / harness)
 */
export async function handleCheckpointStatus(request: Request, env: CheckpointEnv): Promise<Response> {
  if (!authorizeHarness(request, env)) return new Response("Unauthorized", { status: 401 });
  if (!env.USER_STATE) return json({ ok: true, configured: false, exists: false });

  const url = new URL(request.url);
  const userId = safeUserId(url.searchParams.get("userId"));
  if (!userId) return json({ ok: false, error: "invalid_user_id" }, 400);

  const head = await env.USER_STATE.head(CHECKPOINT_OBJECT(userId));
  if (!head) return json({ ok: true, configured: true, exists: false, userId });

  let manifest: CheckpointManifest | null = null;
  try {
    const man = await env.USER_STATE.get(MANIFEST_OBJECT(userId));
    if (man) manifest = (await man.json()) as CheckpointManifest;
  } catch {
    manifest = null;
  }
  return json({
    ok: true,
    configured: true,
    exists: true,
    userId,
    bytes: head.size,
    uploaded: head.uploaded?.toISOString?.() ?? null,
    manifest,
  });
}

export { MAX_CHECKPOINT_BYTES, CHECKPOINT_OBJECT, MANIFEST_OBJECT };
