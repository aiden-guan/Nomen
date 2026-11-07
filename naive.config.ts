import { defineProject } from "@usenaive-sdk/blueprints";

export default defineProject({
  name: "my-project",
  apps: [
    // { name: "dashboard", type: "frontend_only", deploy_dir: "./dist" },
  ],
  agents: [
    // {
    //   name: "assistant",
    //   model: "claude-sonnet-4",
    //   budget: { cap_micro_usd: 50_000_000, max_task_micro_usd: 5_000_000, period: "month" },
    // },
  ],
});
