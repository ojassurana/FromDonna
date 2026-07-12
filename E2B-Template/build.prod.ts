import "dotenv/config";
import { Template, defaultBuildLogger } from "e2b";
import { template, TEMPLATE_NAME_PROD } from "./template.js";

async function main() {
  if (!process.env.E2B_API_KEY) {
    throw new Error("E2B_API_KEY missing — copy .env.example to .env");
  }

  await Template.build(template, TEMPLATE_NAME_PROD, {
    cpuCount: 2,
    memoryMB: 4096,
    onBuildLogs: defaultBuildLogger(),
  });

  console.log(`Built prod template: ${TEMPLATE_NAME_PROD}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
