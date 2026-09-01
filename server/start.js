/**
 * Actual entry point for local dev and the AWS container (see root Dockerfile's CMD and this
 * package's "start" script) — the only thing that calls server.js's start(). Kept as a separate
 * tiny file specifically so requiring server.js on its own (as server/functions-index.js and
 * Firebase's own pre-deploy analysis pass both do) never has the side effect of opening a port —
 * see server.js's start() doc comment for why that distinction matters.
 */
require('./server').start().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
