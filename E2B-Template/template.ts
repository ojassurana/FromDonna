/**
 * FromDonna E2B sandbox template recipe.
 *
 * Build with build.dev.ts / build.prod.ts.
 * Fill install steps as Hermes pin, CLIs, extensions, and harness land.
 *
 * Rules:
 * - No product secrets in the image (Telegram, Nango, user OAuth, Exa, …).
 * - Privileged MCP/API → Worker; only secret-free local MCP may be registered here.
 * - Per-user brain lives in live sandbox ~/.hermes after create, not in this recipe.
 */
import { Template, waitForTimeout } from "e2b";

/** Template alias used by Worker / smoke after publish. */
export const TEMPLATE_NAME_DEV = "fromdonna-hermes-dev";
export const TEMPLATE_NAME_PROD = "fromdonna-hermes";

/**
 * Shared recipe. Extend with .run(), .copy(), etc. as pieces are ready.
 * @see https://e2b.dev/docs/template/quickstart
 */
export const template = Template()
  .fromBaseImage()
  // Placeholder env only — not product secrets.
  .setEnvs({
    FROMDONNA_RUNTIME: "e2b",
    // HERMES_HOME can be set once install path is fixed.
  })
  // TODO: install OS packages / runtimes (python, node, …)
  // TODO: install CLIs (see clis/)
  // TODO: install or copy Hermes pin (see hermes/)
  // TODO: copy config/hermes → ~/.hermes/config.yaml
  // TODO: copy extensions/ (plugins, skills, tools)
  // TODO: optional local MCP from mcp/
  // TODO: copy harness/ and set real start command
  // Warm start stub — replace with harness listen + waitForPort when ready.
  .setStartCmd("echo fromdonna-e2b-template-ready", waitForTimeout(3_000));
