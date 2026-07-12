# Hermes pin

How Hermes gets into the image.

## Options

1. **Upstream pin** — install a fixed Hermes release/commit during `template.ts` build.
2. **Fork** — clone/copy your modified Hermes tree at a **pinned commit** and install from that.

## Rules

- Pin version/commit in the template recipe (no floating `latest` in prod).
- Agent-only: no product bot tokens, no Hermes gateway bound to FromDonna’s Telegram token.
- Deep mods (permissions, custom tools, behavior) live in the Hermes fork; this folder documents the pin and any vendored copy path.

## TODO

- [ ] Choose stock vs fork path  
- [ ] Record pin (tag/commit)  
- [ ] Wire install steps into `../template.ts`  
