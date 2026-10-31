// Build-only adapter. Dev/start and the application runtime never load this hook.
const { installBoundedTrace } = require("./build-trace-io.cjs");
installBoundedTrace();
require("next/dist/bin/next");
