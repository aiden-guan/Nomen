import { defineProject } from "@usenaive-sdk/blueprints";

// Nomen's resources on Naive. Preview with `npm run naive:plan`, apply with `npm run naive:apply`.
// Every name starts with "nomen-" so `naive up` only touches Nomen's own resources, and every
// agent needs a budget you chose, in integer micro-USD (1 USD = 1_000_000). See docs/naive.md.
export default defineProject({
  name: "nomen",
  apps: [
    // { name: "nomen-dashboard", type: "frontend_only", deploy_dir: "./dist" },
  ],
  agents: [
    // {
    //   name: "nomen-researcher",
    //   model: "<an id from `npm run naive -- models list`>",
    //   budget: { cap_micro_usd: <per period>, max_task_micro_usd: <per session>, period: "month" },
    // },
  ],
});
