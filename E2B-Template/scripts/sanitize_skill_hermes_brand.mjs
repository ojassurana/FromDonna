#!/usr/bin/env node
/**
 * Sanitize Hermes product branding from model-visible skill SKILL.md trees.
 * Preserves runtime contracts via protect/restore placeholders.
 */
import fs from "node:fs";
import path from "node:path";

const ROOTS = [
  "/home/ubuntu/FromDonna/E2B-Template/hermes/skills",
  "/home/ubuntu/FromDonna/E2B-Template/hermes/optional-skills",
  "/home/ubuntu/FromDonna/E2B-Template/extensions/skills",
];

const PH = "\0PROT";

function protect(text) {
  const stored = [];
  const stash = (m) => {
    const s = typeof m === "string" ? m : m[0];
    stored.push(s);
    return `${PH}${stored.length - 1}`;
  };

  const patterns = [
    // Nous Hermes LLM model family (not product brand)
    /\bnousresearch\/hermes-[0-9][^\s`'\"\)\]\},;:]*/gi,
    /\bhermes-[34]-\S*/gi,
    /\bHermes \(Nous\)/g,
    /\bHermes models\b/g,
    /\buse Hermes\/Grok models\b/g,
    /\bZero-refusal fast\*\* \(Hermes\)/g,
    /\|\s*Hermes\s*\|\s*prefill_only/g,
    // Env
    /\$\{HERMES_[A-Z0-9_]+(?::-[^}]*)?\}/g,
    /\$HERMES_[A-Z0-9_]+/g,
    /\bHERMES_[A-Z0-9_]+\b/g,
    // Paths
    /~\/\.hermes\b(?:\/[^\s`'"\)\]\},;:]*)?/g,
    /\$HOME\/\.hermes\b(?:\/[^\s`'"\)\]\},;:]*)?/g,
    /\/opt\/hermes\b(?:\/[^\s`'"\)\]\},;:]*)?/g,
    /\/opt\/data(?:\/home)?\/\.hermes\b(?:\/[^\s`'"\)\]\},;:]*)?/g,
    /\.hermes\/plans\b(?:\/[^\s`'"\)\]\},;:]*)?/g,
    /\.hermes\.md\b/g,
    // YAML key line
    /^([ \t]*)hermes:([ \t]*)$/gm,
    // Toolset / modules
    /\bhermes-cli\b/g,
    /\bhermes-api-server\b/g,
    /\bhermes_constants\b/g,
    /\bhermes_cli\b(?:\.[A-Za-z0-9_\.]*)?/g,
    /\bhermes_state\b/g,
    /\bhermes_logging\b/g,
    /\bhermes_time\b/g,
    /\bhermes_bootstrap\b/g,
    /\bget_hermes_home\b/g,
    /\b_hermes_home\.py\b/g,
    /\b_hermes_env\b/g,
    /\b_hermes_home\b/g,
    /\bhermes-gateway\b/g,
    /\bs6-setuidgid hermes\b/g,
    /\b--user hermes\b/g,
    /main-hermes\/run/g,
    /01-hermes-setup/g,
    // CLI invocations in backticks or command lines
    /`hermes(?:\s+[^`]*)?`/g,
    /(?<=\s)hermes(?=\s+(?:pets|teams-pipeline|gateway|skills|setup|cron|honcho|webhook|profile|dashboard|--tui|-p|-q|--toolsets)\b)/g,
    /\bhermes_[a-z][a-z0-9_]*\b/g,
  ];

  for (const re of patterns) {
    text = text.replace(re, stash);
  }
  return { text, stored };
}

function restore(text, stored) {
  return text.replace(/\0PROT(\d+)/g, (_, i) => stored[Number(i)]);
}

function sanitizeBody(text) {
  text = text.replace(/\bhermes-agent-skill-authoring\b/g, "skill-authoring");
  text = text.replace(/\bhermes-s6-container-supervision\b/g, "s6-container-supervision");
  text = text.replace(/\bhermes-agent-dev\b/g, "donna-agent-dev");
  text = text.replace(/\bdebugging-hermes-tui-commands\b/g, "debugging-tui-commands");
  text = text.replace(/skill_view\(name=['"]hermes-agent['"]\)/g, "skill_view(name='donna-agent')");
  text = text.replace(/\bhermes-agent\b/g, "donna-agent");

  text = text.replace(/author:\s*Hermes Agent(\s*\([^)]*\))?/g, (_, p) => `author: Donna${p || ""}`);
  text = text.replace(/author:\s*hermes-agent\b/g, "author: Donna");
  text = text.replace(/,\s*Hermes Agent\b/g, ", Donna");
  text = text.replace(/\benhanced by Hermes Agent\b/g, "enhanced by Donna");
  text = text.replace(/\bported into hermes-agent\b/g, "ported into Donna");
  text = text.replace(/\bHermes Agent \+ /g, "Donna + ");
  text = text.replace(/\+ Hermes Agent\b/g, "+ Donna");

  text = text.replace(/\bHermes-Agent\b/g, "Donna");
  text = text.replace(/\bHermes Agent's\b/g, "Donna's");
  text = text.replace(/\bHermes Agent\b/g, "Donna");
  text = text.replace(/\bHermes's\b/g, "Donna's");
  text = text.replace(/\bHermes'\b/g, "Donna's");

  text = text.replace(/\bTypical Hermes Workflow\b/g, "Typical Workflow");
  text = text.replace(/\bImportant Notes for Hermes\b/g, "Important Notes");
  text = text.replace(/\bHermes Agent Integration\b/g, "Agent Integration");
  text = text.replace(/\bHermes Tool Patterns\b/g, "Tool Patterns");
  text = text.replace(/\bHermes Execution Pattern\b/g, "Agent Execution Pattern");
  text = text.replace(/\bHermes Orchestration Guide\b/g, "Orchestration Guide");
  text = text.replace(/\bHermes-specific\b/g, "Agent-specific");
  text = text.replace(/\bHermes-managed\b/g, "agent-managed");
  text = text.replace(/\bHermes-compatible\b/g, "agent-compatible");
  text = text.replace(/\bHermes-run\b/g, "agent-run");
  text = text.replace(/\bHermes-tool\b/g, "agent-tool");
  text = text.replace(/\bHermes-format\b/g, "skill-format");
  text = text.replace(/\bHermes-native\b/g, "agent-native");
  text = text.replace(/\bfor Hermes Agents\b/g, "for Agents");
  text = text.replace(/\bRules for Hermes Agents\b/g, "Rules for Agents");
  text = text.replace(/\bfor Hermes\b/g, "for the agent");
  text = text.replace(/\bwith Hermes\b/g, "with the agent");
  text = text.replace(/\bto Hermes\b/g, "to the agent");
  text = text.replace(/\binto Hermes\b/g, "into the agent");
  text = text.replace(/\bin Hermes\b/g, "in the agent");
  text = text.replace(/\bvia Hermes\b/g, "via the agent");
  text = text.replace(/\bon Hermes\b/g, "on the agent");
  text = text.replace(/\bfrom Hermes\b/g, "from the agent");
  text = text.replace(/\bof Hermes\b/g, "of the agent");
  text = text.replace(/\bby Hermes\b/g, "by the agent");
  text = text.replace(/\bFor Hermes:\b/g, "For the agent:");

  text = text.replace(/https?:\/\/hermes-agent\.nousresearch\.com[^\s\)\]`'\"\,]*/g, "(product docs — internal)");
  text = text.replace(/https?:\/\/github\.com\/NousResearch\/hermes-agent[^\s\)\]`'\"\,]*/g, "https://fromdonna.ai");
  text = text.replace(/NousResearch\/hermes-agent/g, "product-repo");

  text = text.replace(/\bHermes\b/g, "Donna");

  text = text.replace(/\brestart hermes\b/gi, "restart the agent");
  text = text.replace(/--client hermes\b/g, "--client donna");
  text = text.replace(/\(e\.g\.\s*`hermes`\)/g, "(e.g. `donna`)");
  text = text.replace(/"Hermes"/g, '"Donna"');
  text = text.replace(/"generator":\s*"donna-agent code-wiki/g, '"generator": "donna code-wiki');
  text = text.replace(/\bhermes-agent-harness\b/g, "donna-agent-harness");
  text = text.replace(/\/home\/bb\/donna-agent\b/g, "/path/to/repo");
  text = text.replace(/\/home\/bb\/hermes-agent\b/g, "/path/to/repo");
  text = text.replace(/hermes-outreach/g, "donna-outreach");
  text = text.replace(/--name hermes-issues\b/g, "--name donna-issues");
  text = text.replace(/\bhermes-tool-quirks\b/g, "agent-tool-quirks");

  text = text.replace(/tags:\s*\[([^\]]*)\]/g, (_, inner) => {
    const cleaned = inner
      .replace(/\bhermes-agent\b/g, "donna-agent")
      .replace(/\bHermes\b/g, "Donna")
      .replace(/(^|,\s*)hermes(\s*,|$)/gi, "$1donna$2");
    return `tags: [${cleaned}]`;
  });

  text = text.replace(/\bImportant Donna CLI note\b/g, "Important CLI note");
  text = text.replace(/\bthis Donna \/ FromDonna\b/g, "this FromDonna");
  text = text.replace(/\bthis agent \/ FromDonna\b/g, "this FromDonna");
  text = text.replace(/\bthis Donna\b/g, "this agent");
  text = text.replace(/\bhomepage:\s*\(product docs — internal\)\S*/g, "homepage: https://fromdonna.ai");
  text = text.replace(/\bdonna-agent users\b/g, "Donna users");
  text = text.replace(/\bAuthoring Donna Skills\b/g, "Authoring Skills");
  text = text.replace(/# Authoring Donna Skills \(in-repo\)/g, "# Authoring Skills (in-repo)");
  text = text.replace(/# Donna s6-overlay Container Supervision/g, "# s6-overlay Container Supervision");
  text = text.replace(/# OpenClaw -> Donna Migration/g, "# OpenClaw -> Donna Migration");
  text = text.replace(/# Honcho Memory for Donna/g, "# Honcho Memory for Donna");
  text = text.replace(/name: hermes-agent-skill-authoring/g, "name: skill-authoring");
  text = text.replace(/name: hermes-s6-container-supervision/g, "name: s6-container-supervision");
  text = text.replace(/\bship with donna-agent\b/g, "ship with the agent package");
  text = text.replace(/\bRestart Donna\b/g, "Restart the agent");
  text = text.replace(/\brestart Donna\b/g, "restart the agent");
  text = text.replace(/\bDonna Config\b/g, "Agent Config");
  text = text.replace(/\bin their Donna config\b/g, "in their agent config");
  text = text.replace(/\bin Donna config\b/g, "in agent config");
  text = text.replace(/\bthe Donna config\b/g, "the agent config");
  text = text.replace(/\bwhile the Donna config\b/g, "while the agent config");
  text = text.replace(/\bDonna cannot see\b/g, "The agent cannot see");
  text = text.replace(/\bDonna already loads\b/g, "The agent already loads");
  text = text.replace(/\bDonna creates two peers\b/g, "The agent creates two peers");
  text = text.replace(/\bevery Donna profile\b/g, "every agent profile");
  text = text.replace(/\bEach Donna profile\b/g, "Each agent profile");
  text = text.replace(/\bthis Donna profile\b/g, "this agent profile");
  text = text.replace(/\bthis Donna instance\b/g, "this agent instance");
  text = text.replace(/\ball Donna profiles\b/g, "all agent profiles");
  text = text.replace(/\bDonna profiles\b/g, "agent profiles");
  text = text.replace(/\bDonna profile\b/g, "agent profile");
  text = text.replace(/\bDonna home directory\b/g, "agent home directory");
  text = text.replace(/\bDonna memory entries\b/g, "agent memory entries");
  text = text.replace(/\bDonna working-directory\b/g, "agent working-directory");
  text = text.replace(/\bDonna workspace\b/g, "agent workspace");
  text = text.replace(/\bDonna destination\b/g, "agent destination");
  text = text.replace(/\bDonna CLI\b/g, "agent CLI");
  text = text.replace(/\bDonna terminal\b/g, "agent terminal");
  text = text.replace(/\bDonna tools\b/g, "agent tools");
  text = text.replace(/\bDonna file tools\b/g, "agent file tools");
  text = text.replace(/\bDonna skill\b/g, "agent skill");
  text = text.replace(/\bDonna skills\b/g, "agent skills");
  text = text.replace(/\bDonna subagents\b/g, "agent subagents");
  text = text.replace(/\bDonna memory\b/g, "agent memory");
  text = text.replace(/\bDonna core\b/g, "agent core");
  text = text.replace(/\bDonna itself\b/g, "the agent itself");
  text = text.replace(/\bDonna gateway\b/g, "agent gateway");
  text = text.replace(/\bDonna Kanban\b/g, "agent Kanban");
  text = text.replace(/\bDonna Docker\b/g, "agent Docker");
  text = text.replace(/\bDonna TTS\b/g, "agent TTS");
  text = text.replace(/\bDonna STT\/TTS\b/g, "agent STT/TTS");
  text = text.replace(/\bDonna adaptation\b/g, "Agent adaptation");
  text = text.replace(/\bDonna-run\b/g, "agent-run");
  text = text.replace(/\bDonna-managed\b/g, "agent-managed");
  text = text.replace(/\bDonna-compatible\b/g, "agent-compatible");
  text = text.replace(/\bDonna-native\b/g, "agent-native");
  text = text.replace(/\bDonna-format\b/g, "skill-format");
  text = text.replace(/\bDonna-specific\b/g, "Agent-specific");
  text = text.replace(/\bDonna-tool\b/g, "agent-tool");
  text = text.replace(/\ba Donna agent\b/g, "the agent");
  text = text.replace(/\bthe Donna agent\b/g, "the agent");
  text = text.replace(/\bGuidelines for Donna when\b/g, "Guidelines for the agent when");
  text = text.replace(/\beach Donna run\b/g, "each agent run");
  text = text.replace(/\bDonna persona state\b/g, "agent persona state");
  text = text.replace(/\bDonna memory files\b/g, "agent memory files");
  text = text.replace(/\bDonna targets\b/g, "agent targets");
  text = text.replace(/\bout of Donna\b/g, "out of the agent");
  text = text.replace(/\bexist in Donna\b/g, "exist in the agent");
  text = text.replace(/\binto a Donna workspace\b/g, "into an agent workspace");
  text = text.replace(/\bsave credentials into Donna\b/g, "save credentials into the agent");
  text = text.replace(/\bAsk Donna to create\b/g, "Ask the agent to create");
  text = text.replace(/\bI want Donna to own\b/g, "I want the agent to own");
  text = text.replace(/\bturn Donna into\b/g, "turn the agent into");
  text = text.replace(/\bgives Donna practical\b/g, "gives the agent practical");
  text = text.replace(/\bGive Donna phone\b/g, "Give the agent phone");
  text = text.replace(/\bConnect Donna to\b/g, "Connect the agent to");
  text = text.replace(/\bso Donna can\b/g, "so the agent can");
  text = text.replace(/\bDonna can complete\b/g, "the agent can complete");
  text = text.replace(/\bDonna cannot self-approve\b/g, "the agent cannot self-approve");
  text = text.replace(/\bbefore Donna attempts\b/g, "before the agent attempts");
  text = text.replace(/\bDonna can pay\b/g, "the agent can pay");
  text = text.replace(/\bDonna can provision\b/g, "the agent can provision");
  text = text.replace(/\bmachine running Donna\b/g, "machine running the agent");
  text = text.replace(/\bmascots for Donna\b/g, "mascots for the agent");
  text = text.replace(/\bavailable in Donna\b/g, "available in the agent");
  text = text.replace(/\bclean for Donna\b/g, "clean for the agent");
  text = text.replace(/\bHello from Donna!\b/g, "Hello from Donna!");
  text = text.replace(/\bThis is Donna calling\b/g, "This is Donna calling");
  text = text.replace(/\bcore Donna dependency\b/g, "core agent dependency");
  text = text.replace(/\bDonna uses its own\b/g, "the agent uses its own");
  text = text.replace(/\bDonna subprocess HOME\b/g, "agent subprocess HOME");
  text = text.replace(/\bDonna tool subprocesses\b/g, "agent tool subprocesses");
  text = text.replace(/\bDonna tool calls\b/g, "agent tool calls");
  text = text.replace(/\bDonna terminal calls\b/g, "agent terminal calls");
  text = text.replace(/\bDonna terminal commands\b/g, "agent terminal commands");
  text = text.replace(/\bDonna's compression\b/g, "the agent's compression");
  text = text.replace(/\bDonna's own system prompt\b/g, "the agent's own system prompt");
  text = text.replace(/\bDonna's normal personality\b/g, "the agent's normal personality");
  text = text.replace(/\bDonna's existing\b/g, "the agent's existing");
  text = text.replace(/\bDonna's configured\b/g, "the agent's configured");
  text = text.replace(/\bDonna's MIT license\b/g, "the agent's MIT license");
  text = text.replace(/\bDonna's tool ecosystem\b/g, "the agent's tool ecosystem");
  text = text.replace(/\bDonna's built-in\b/g, "the agent's built-in");
  text = text.replace(/\bDonna's xAI auth\b/g, "the agent's xAI auth");
  text = text.replace(/\bDonna's native MCP\b/g, "the agent's native MCP");
  text = text.replace(/\bAttach to Donna\b/g, "Attach to process");
  text = text.replace(/\bDebugging Donna ui-tui\b/g, "Debugging ui-tui");
  text = text.replace(/\bDebugging Donna-specific Processes\b/g, "Debugging agent-specific processes");
  text = text.replace(/\b### Donna Tools Reference\b/g, "### Agent Tools Reference");
  text = text.replace(/\b## Recommended Donna usage patterns\b/g, "## Recommended agent usage patterns");
  text = text.replace(/\bRecommended Donna workflow\b/g, "Recommended agent workflow");
  text = text.replace(/\bRecommended Donna TTS\b/g, "Recommended agent TTS");
  text = text.replace(/\bnot a Donna core capability\b/g, "not a core agent capability");
  text = text.replace(/\bPrefer Donna native\b/g, "Prefer agent native");
  text = text.replace(/\bwhen Donna native tools\b/g, "when agent native tools");
  text = text.replace(/\bit overlaps with Donna native\b/g, "it overlaps with agent native");
  text = text.replace(/\bNOT Donna-format skills\b/g, "NOT skill-format skills");
  text = text.replace(/\bNOT in Donna SKILL\.md format\b/g, "NOT in SKILL.md format");
  text = text.replace(/\binto Donna itself\b/g, "into the agent itself");
  text = text.replace(/\binside Donna core\b/g, "inside agent core");
  text = text.replace(/\bDonna installs package\b/g, "the agent installs package");
  text = text.replace(/\bbacked by Donna Kanban\b/g, "backed by agent Kanban");
  text = text.replace(/\bin a Donna Kanban pipeline\b/g, "in an agent Kanban pipeline");
  text = text.replace(/\bcreates Donna profiles\b/g, "creates agent profiles");
  text = text.replace(/\bwhich Donna skills\b/g, "which agent skills");
  text = text.replace(/\bwhichever Donna rendering\b/g, "whichever agent rendering");
  text = text.replace(/\bvia the Donna terminal\b/g, "via the agent terminal");
  text = text.replace(/\bfrom Donna\b/g, "from the agent");
  text = text.replace(/\bauthenticate from Donna itself\b/g, "authenticate from the agent itself");
  text = text.replace(/\bthrough the Donna `terminal`\b/g, "through the agent `terminal`");
  text = text.replace(/\bvia Donna `text_to_speech`\b/g, "via agent `text_to_speech`");
  text = text.replace(/\bwith Donna `text_to_speech`\b/g, "with agent `text_to_speech`");
  text = text.replace(/\breusing Donna's existing\b/g, "reusing the agent's existing");
  text = text.replace(/\bpairs well with Donna\b/g, "pairs well with the agent");
  text = text.replace(/\bWhen Donna runs\b/g, "When the agent runs");
  text = text.replace(/\binherit the Donna\b/g, "inherit the agent");
  text = text.replace(/\bIf Donna restarts\b/g, "If the agent restarts");
  text = text.replace(/\bafter Donna's own\b/g, "after the agent's own");
  text = text.replace(/\brequires Donna to be pointed\b/g, "requires the agent to be pointed");
  text = text.replace(/\bwire it via Donna's MCP\b/g, "wire it via the agent's MCP");
  text = text.replace(/\bpreserving Donna's existing\b/g, "preserving the agent's existing");
  text = text.replace(/\bthrough agent-managed OAuth\b/g, "through agent-managed OAuth");
  text = text.replace(/\bmodel-invoked Donna skill\b/g, "model-invoked skill");
  text = text.replace(/\bAgent-specific recipes\b/g, "Agent-specific recipes");
  text = text.replace(/\bAgent-specific note\b/g, "Agent-specific note");
  text = text.replace(/\bFor Donna subagents\b/g, "For agent subagents");
  text = text.replace(/\bFrom inside Donna\b/g, "From inside the agent");
  text = text.replace(/\bIn Donna, launch\b/g, "In the agent, launch");
  text = text.replace(/\bofficial Donna Docker layout\b/g, "official agent Docker layout");
  text = text.replace(/\breformatted for Donna skill conventions\b/g, "reformatted for skill conventions");
  text = text.replace(/\breformatted for agent skill conventions\b/g, "reformatted for skill conventions");
  text = text.replace(/\bvendor":"Donna"/g, 'vendor":"Donna"');
  text = text.replace(/\bName the token \(e\.g\., "Donna"\)/g, 'Name the token (e.g., "Donna")');
  text = text.replace(/\bTelegram \(Donna \+ all other agents\)/g, "Telegram (Donna + all other agents)");
  text = text.replace(/\bOpenClaw -> Donna Migration\b/g, "OpenClaw → Donna Migration");
  text = text.replace(/\bmove their OpenClaw setup into Donna\b/g, "move their OpenClaw setup into Donna");
  text = text.replace(/\bImports agent-compatible memories\b/g, "Imports agent-compatible memories");
  text = text.replace(/\brelated_skills: \[donna-agent, donna-agent-dev\]/g, "related_skills: [donna-agent]");
  text = text.replace(/`donna-agent-dev`: General donna-agent codebase navigation/g, "`donna-agent`: product agent codebase navigation");
  text = text.replace(/General donna-agent codebase navigation/g, "General agent codebase navigation");
  text = text.replace(/interaction with hermes built-in tools/g, "interaction with agent built-in tools");
  text = text.replace(/interaction with Donna built-in tools/g, "interaction with agent built-in tools");
  text = text.replace(/\bdrops to hermes via\b/g, "drops to hermes via"); // protected typically
  text = text.replace(/\bmain hermes is unsupervised\b/g, "main process is unsupervised");
  text = text.replace(/\bmain hermes to run\b/g, "main process to run");
  text = text.replace(/\bmain hermes runs as\b/g, "main process runs as");
  text = text.replace(/\bThe hermes binary works\b/g, "The hermes binary works"); // CLI binary name OK
  text = text.replace(/\bThe reconciler runs as hermes\b/g, "The reconciler runs as hermes"); // docker user OK
  text = text.replace(/\bchowns \$HERMES_HOME\/profiles` to hermes\b/g, "chowns `$HERMES_HOME/profiles` to hermes");
  text = text.replace(/\bauthor: Donna\nlicense: MIT\nplatforms: \[linux\]\nenvironments: \[s6\]\nmetadata:\n/g,
    "author: Donna\nlicense: MIT\nplatforms: [linux]\nenvironments: [s6]\nmetadata:\n");

  // Fix skill-authoring example author in yaml block if still Hermes
  text = text.replace(/author: Hermes Agent\n/g, "author: Donna\n");

  // name field if still wrong after first pass
  text = text.replace(/^name: hermes-agent-skill-authoring$/m, "name: skill-authoring");
  text = text.replace(/^name: hermes-s6-container-supervision$/m, "name: s6-container-supervision");

  // Title for skill-authoring
  text = text.replace(/^# Authoring Hermes-Agent Skills \(in-repo\)$/m, "# Authoring Skills (in-repo)");
  text = text.replace(/^# Authoring Donna Skills \(in-repo\)$/m, "# Authoring Skills (in-repo)");

  // s6 title
  text = text.replace(/^# Hermes s6-overlay Container Supervision$/m, "# s6-overlay Container Supervision");
  text = text.replace(/^# Donna s6-overlay Container Supervision$/m, "# s6-overlay Container Supervision");

  // connect-apps cleanup
  text = text.replace(/\bthis Donna \/ FromDonna sandbox\b/g, "this FromDonna sandbox");
  text = text.replace(/\bthis agent \/ FromDonna sandbox\b/g, "this FromDonna sandbox");

  return text;
}

function processFile(filePath) {
  const original = fs.readFileSync(filePath, "utf8");
  const { text: protectedText, stored } = protect(original);
  let result = sanitizeBody(protectedText);
  result = restore(result, stored);
  if (result.includes("\0PROT")) {
    result = restore(result, stored);
  }
  if (result.includes("\0PROT")) {
    console.error("ERROR leftover placeholders:", filePath);
    return false;
  }
  if (result !== original) {
    fs.writeFileSync(filePath, result, "utf8");
    return true;
  }
  return false;
}

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) walk(p, out);
    else if (ent.name === "SKILL.md") out.push(p);
  }
  return out;
}

let updated = 0;
let total = 0;
for (const root of ROOTS) {
  const files = walk(root);
  for (const f of files) {
    total++;
    if (processFile(f)) {
      updated++;
      console.log("updated:", f);
    }
  }
}
console.log(`\nDone: ${updated}/${total} SKILL.md files updated`);
