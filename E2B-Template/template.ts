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
  })
  .copy("hermes", "/opt/fromdonna/hermes")
  .copy("harness", "/opt/fromdonna/harness")
  .copy("extensions/plugins", "/home/user/.hermes/plugins")
  .copy("config/hermes/config.yaml", "/home/user/.hermes/config.yaml")
  // messaging extra pulls python-telegram-bot — required for official TelegramAdapter
  // inside the sandbox (without it connect() returns False immediately).
  .runCmd(
    "uv venv /home/user/venv --python python3 && " +
      "uv pip install --python /home/user/venv/bin/python '/opt/fromdonna/hermes[messaging]' && " +
      "mkdir -p /home/user/workspace",
  )
  .setStartCmd(
    "/home/user/venv/bin/uvicorn server:app --app-dir /opt/fromdonna/harness --host 0.0.0.0 --port 8788",
    waitForPort(8788),
  );
