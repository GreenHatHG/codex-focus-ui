#!/usr/bin/env node

const { META, PORT, startViewerServer } = require("./app");

startViewerServer(PORT).then(() => {
  console.log(`[codex-focus-ui viewer] v${META.version} running at http://127.0.0.1:${PORT}`);
  console.log("Project-first viewer ready: project/session switch, global search, export, and real rollout deletion are enabled.");
}).catch((error) => {
  console.error(`[codex-focus-ui viewer] failed to start: ${error.message}`);
  process.exit(1);
});
