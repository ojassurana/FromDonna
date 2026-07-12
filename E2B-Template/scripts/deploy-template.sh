#!/usr/bin/env bash
# Deploy (build + publish) the FromDonna E2B sandbox template.
# Does not create user sandboxes — only publishes the template image to E2B.
#
# Usage:
#   ./scripts/deploy-template.sh              # dev template
#   ./scripts/deploy-template.sh --prod       # production template
#   ./scripts/deploy-template.sh --dev --smoke
#   ./scripts/deploy-template.sh --dry-run    # checks only, no E2B build
#   ./scripts/deploy-template.sh --help
#
# Prerequisites:
#   - Node 20+
#   - E2B_API_KEY in E2B-Template/.env (see .env.example)
#   - template.ts recipe filled enough to build (Hermes install still TODO)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

ENV=dev
SMOKE=0
DRY_RUN=0
SKIP_INSTALL=0

usage() {
  sed -n '2,16p' "$0" | sed 's/^# \?//'
  exit 0
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dev) ENV=dev; shift ;;
    --prod) ENV=prod; shift ;;
    --smoke) SMOKE=1; shift ;;
    --dry-run) DRY_RUN=1; shift ;;
    --skip-install) SKIP_INSTALL=1; shift ;;
    -h|--help) usage ;;
    *)
      echo "Unknown arg: $1" >&2
      usage
      ;;
  esac
done

log() { printf '==> %s\n' "$*"; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }

# --- preflight ---
log "cwd: $ROOT"
command -v node >/dev/null || die "node not found (need Node 20+)"
NODE_MAJOR="$(node -p "process.versions.node.split('.')[0]")"
if [[ "$NODE_MAJOR" -lt 20 ]]; then
  die "Node $NODE_MAJOR detected; need >= 20"
fi
log "node $(node -v)"

if [[ ! -f .env ]]; then
  die "missing .env — copy .env.example and set E2B_API_KEY"
fi

# shellcheck disable=SC1091
set -a
# shellcheck source=/dev/null
source .env
set +a

if [[ -z "${E2B_API_KEY:-}" || "$E2B_API_KEY" == "e2b_***" ]]; then
  die "E2B_API_KEY unset or still placeholder in .env"
fi
log "E2B_API_KEY present (${#E2B_API_KEY} chars)"

[[ -f template.ts ]] || die "template.ts missing"
[[ -f build.dev.ts && -f build.prod.ts ]] || die "build.dev.ts / build.prod.ts missing"
[[ -d hermes ]] || die "hermes/ missing — expected vendored agent under E2B-Template/hermes"

if [[ -f hermes/FROMDONNA.md ]]; then
  log "hermes pin note:"
  grep -E 'Upstream commit|Cloned' hermes/FROMDONNA.md | sed 's/^/    /' || true
fi

if [[ "$SKIP_INSTALL" -eq 0 ]]; then
  log "npm install"
  npm install
else
  log "skip npm install"
  [[ -d node_modules/e2b ]] || die "node_modules/e2b missing — run without --skip-install"
fi

TAG="fromdonna-hermes-dev"
BUILD_SCRIPT="build:dev"
if [[ "$ENV" == "prod" ]]; then
  TAG="fromdonna-hermes"
  BUILD_SCRIPT="build:prod"
fi

log "target template tag: $TAG"
log "mode: $ENV"

if [[ "$DRY_RUN" -eq 1 ]]; then
  log "dry-run: preflight OK — would run: npm run $BUILD_SCRIPT"
  if [[ "$SMOKE" -eq 1 ]]; then
    log "dry-run: would run: npm run smoke (expects template already built)"
  fi
  log "dry-run complete (no E2B API build)"
  exit 0
fi

# --- publish template to E2B ---
log "building & publishing template via npm run $BUILD_SCRIPT"
npm run "$BUILD_SCRIPT"
log "published: $TAG"

if [[ "$SMOKE" -eq 1 ]]; then
  if [[ "$ENV" != "dev" ]]; then
    log "note: smoke-create.ts currently uses dev tag; prefer --dev --smoke"
  fi
  log "smoke: create one sandbox and probe"
  npm run smoke
fi

log "done"
log "Worker: Sandbox.create(\"$TAG\")"
