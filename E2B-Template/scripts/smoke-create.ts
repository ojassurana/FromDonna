/**
 * Create one sandbox from the dev template and print basic probes.
 * Requires a successful npm run build:dev first.
 */
import "dotenv/config";
import { Sandbox } from "e2b";
import { TEMPLATE_NAME_DEV } from "../template.js";

async function main() {
  if (!process.env.E2B_API_KEY) {
    throw new Error("E2B_API_KEY missing");
  }

  const sandbox = await Sandbox.create(TEMPLATE_NAME_DEV);
  try {
    const who = await sandbox.commands.run("whoami && /home/user/venv/bin/hermes --version");
    console.log(who.stdout);
    const health = await fetch(`https://${sandbox.getHost(8788)}/health`);
    if (!health.ok) throw new Error(`Harness health failed: HTTP ${health.status}`);
    console.log(await health.text());
  } finally {
    await sandbox.kill();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
