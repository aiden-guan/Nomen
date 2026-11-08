import { readFileSync } from "node:fs";
import { defineProject } from "@usenaive-sdk/blueprints";

// Nomen's resources on Naive. Preview with `npm run naive:plan`, apply with `npm run naive:apply`.
// Every name starts with "nomen-" so `naive up` only touches Nomen's own resources, and every
// agent needs a budget you chose, in integer micro-USD (1 USD = 1_000_000). See docs/naive.md.
//
// Most of Nomen's Naive spend is video rendering, which the app calls directly and is not held
// against these budgets. The strategist only reasons over research Nomen already collected on
// Monid, so it gets no tools: it cannot browse, buy, post or spend on its own.
export default defineProject({
  name: "nomen",
  apps: [],
  agents: [
    {
      name: "nomen-strategist",
      description: "Turns Nomen's research pack into a brand brief, a search plan and UGC video concepts.",
      model: "anthropic/claude-sonnet-5.5",
      budget: { cap_micro_usd: 40_000_000, max_task_micro_usd: 4_000_000, period: "month" },
      system: readFileSync(new URL("./naive/agents/strategist.md", import.meta.url), "utf8"),
      tools: { default_config: { permission: "deny" }, configs: {} },
      handoffs: false,
    },
  ],
});
