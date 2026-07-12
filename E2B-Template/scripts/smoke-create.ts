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
    const who = await sandbox.commands.run("whoami && uname -a");
    console.log(who.stdout);
    // Uncomment as installs land:
    // console.log((await sandbox.commands.run("which hermes || true")).stdout);
    // console.log((await sandbox.commands.run("hermes --version || true")).stdout);
  } finally {
    await sandbox.kill();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
