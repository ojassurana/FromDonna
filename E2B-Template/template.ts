import { Template, waitForPort } from "e2b";

/** Template aliases used by the gateway Worker. */
export const TEMPLATE_NAME_DEV = "fromdonna-hermes-dev";
export const TEMPLATE_NAME_PROD = "fromdonna-hermes";

/**
 * Shared FromDonna sandbox image. It contains the vendored Hermes source,
 * agent-only configuration, and the Worker-facing harness — never channel or
 * provider secrets.
 */
export const template = Template()
  .fromBaseImage()
  .aptInstall(["curl", "ca-certificates", "python3", "python3-venv"])
  .runCmd("curl -LsSf https://astral.sh/uv/install.sh | sh")
  .setEnvs({
    PATH: "/home/user/.local/bin:/home/user/venv/bin:$PATH",
    FROMDONNA_RUNTIME: "e2b",
    HERMES_HOME: "/home/user/.hermes",
    // Exa via dedicated API proxy (real key never in the image). Overridden at
    // create/bootstrap with the live api-proxy URL when needed.
    EXA_API_KEY: "STUB",
    FROMDONNA_API_PROXY_URL: "https://fromdonna-api-proxy.code-df4.workers.dev",
    EXA_BASE_URL: "https://fromdonna-api-proxy.code-df4.workers.dev/v1/exa",
  })
  .copy("hermes", "/opt/fromdonna/hermes")
  .copy("harness", "/opt/fromdonna/harness")
  .copy("extensions/plugins", "/home/user/.hermes/plugins")
  // Product skills → Hermes primary skills tree (scanned as ~/.hermes/skills/).
  // Layout: <category>/<skill-name>/SKILL.md (Hermes progressive skill_view load).
  .copy("extensions/skills", "/home/user/.hermes/skills")
  .copy("config/hermes/config.yaml", "/home/user/.hermes/config.yaml")
  .copy("config/hermes/SOUL.md", "/home/user/.hermes/SOUL.md")
  // Seed agent notes (not persona). Points at connect-apps skill for OAuth.
  .copy(
    "config/hermes/memories/MEMORY.md",
    "/home/user/.hermes/memories/MEMORY.md",
  )
  // messaging: TelegramAdapter; exa: web_search; mcp: Hermes MCP client
  // (required for Composio mcp_servers.composio — without the `mcp` extra,
  // discover_mcp_tools is a no-op and Gmail connect tools never appear).
  .runCmd(
    "uv venv /home/user/venv --python python3 && " +
      "uv pip install --python /home/user/venv/bin/python '/opt/fromdonna/hermes[messaging,exa,mcp]' && " +
      "mkdir -p /home/user/workspace",
  )
  .setStartCmd(
    "/home/user/venv/bin/uvicorn server:app --app-dir /opt/fromdonna/harness --host 0.0.0.0 --port 8788",
    waitForPort(8788),
  );
