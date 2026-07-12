# Hermes (FromDonna fork workspace)

This directory is the **source pin** for the agent runtime baked into `E2B-Template`.

## Intent

- Stock or heavily modified Hermes lives **here** (or is vendored/submoduled here).
- `E2B-Template` builds the E2B image **from this tree** at a known commit — it does not own product secrets or Worker code.
- Per-user live state after deploy is still sandbox `~/.hermes` + R2 (see `documentation/deployment/memorymanagement.md`).

## Status

Empty placeholder. Next steps when you start hacking:

1. Add upstream as git submodule **or** copy/clone your fork into this directory.
2. Record the pin (commit/tag) used by `E2B-Template/template.ts`.
3. Keep gateway/channel tokens out of this tree for product multi-user deploys.

## Not this folder

| Here | Elsewhere |
|------|-----------|
| Hermes engine + your patches | `cloudflare/` — Worker, R2, channels |
| Agent tools/plugins you ship in-tree | `E2B-Template/` — image recipe only |
| | `documentation/` — design docs |

## Related

- `E2B-Template/hermes/README.md` — how the template installs this pin
- `documentation/deployment/e2b-template.md` — template design
