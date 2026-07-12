# E2B-Template

Everything needed to **build and publish** the FromDonna per-user sandbox image (Hermes + CLIs + extensions + harness).

Product docs:

- [documentation/deployment/e2b-template.md](../documentation/deployment/e2b-template.md) — design
- [documentation/deployment/memorymanagement.md](../documentation/deployment/memorymanagement.md) — sandbox vs R2 vs `~/.hermes`
- [documentation/tooling/general.md](../documentation/tooling/general.md) — secrets stay on Worker

## Layout

```
E2B-Template/
├── README.md                 ← this file
├── package.json              ← e2b SDK + build scripts
├── .env.example              ← E2B_API_KEY only (never commit real keys)
├── template.ts               ← E2B Template() recipe (source of truth for build)
├── build.dev.ts              ← publish template tag: fromdonna-hermes-dev
├── build.prod.ts             ← publish template tag: fromdonna-hermes
├── config/
│   └── hermes/               ← default agent-only Hermes config (no product secrets)
│       └── config.yaml.example
├── hermes/                   ← optional: pin/instructions for stock or forked Hermes
│   └── README.md
├── extensions/               ← product plugins, bundled skills, agent tools
│   ├── plugins/.gitkeep
│   ├── skills/.gitkeep
│   └── tools/.gitkeep
├── clis/                     ← install scripts / wrappers for CLIs baked into the image
│   └── README.md
├── mcp/                      ← secret-free local MCP only (privileged MCP → Worker)
│   └── README.md
├── harness/                  ← HTTP entry Worker will call (POST turn → reply)
│   └── README.md
└── scripts/
    └── smoke-create.ts       ← create one sandbox from template and probe PATH
```

## What is baked vs not

| Baked into E2B template | Not in this image |
|-------------------------|-------------------|
| Hermes (pinned / your fork) | Channel tokens |
| Default config + extensions you ship to everyone | Nango / OAuth secrets |
| CLIs on PATH | Per-user `~/.hermes` brain |
| Secret-free local MCP | User R2 files |
| Harness process (optional warm start) | |

## Prerequisites

- Node 20+
- `E2B_API_KEY` in `.env` (from [E2B dashboard](https://e2b.dev/dashboard?tab=keys))
- E2B SDK ≥ 2.3.0 (see `package.json`)

```bash
cd E2B-Template
cp .env.example .env   # fill E2B_API_KEY
npm install
```

## Build

```bash
# Development tag
npm run build:dev
# → template name: fromdonna-hermes-dev

# Production tag
npm run build:prod
# → template name: fromdonna-hermes
```

Worker create path:

```ts
import { Sandbox } from "e2b";
const sandbox = await Sandbox.create("fromdonna-hermes"); // or fromdonna-hermes-dev
```

## Smoke

```bash
npm run smoke
```

## Development cycle

1. Change Hermes pin / extensions / CLIs / harness / `template.ts`
2. `npm run build:dev`
3. Point Worker (or smoke) at `fromdonna-hermes-dev`
4. When happy: `npm run build:prod`
5. Existing users keep old sandboxes until you migrate (`~/.hermes` restore — see memory doc)

## Status

Scaffold for deployment. Recipe steps in `template.ts` are **stubs** until Hermes install, CLIs, and harness are filled in. Do not treat current build as production-ready without completing those steps and a real smoke test.
