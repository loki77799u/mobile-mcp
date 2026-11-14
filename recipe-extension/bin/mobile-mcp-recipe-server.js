#!/usr/bin/env node
"use strict";

const McpProxyServer = require("../src/proxy");
const config = require("../src/config");

// Ensure stdout is used exclusively for MCP JSON-RPC protocol
// All diagnostics go to stderr
const originalStdoutWrite = process.stdout.write.bind(process.stdout);
console.log = (...args) => process.stderr.write(args.join(" ") + "\n");
console.info = (...args) => process.stderr.write(args.join(" ") + "\n");
console.warn = (...args) => process.stderr.write(args.join(" ") + "\n");
console.error = (...args) => process.stderr.write(args.join(" ") + "\n");

// Parse minimal CLI options
const args = process.argv.slice(2);
let customStoreDir = config.STORE_DIR;
let customUpstreamCmd = config.UPSTREAM_COMMAND;
let customUpstreamArgs = config.UPSTREAM_ARGS;

for (let i = 0; i < args.length; i++) {
  if (args[i] === "--store" && args[i + 1]) {
    customStoreDir = args[++i];
  } else if (args[i] === "--upstream" && args[i + 1]) {
    customUpstreamCmd = args[++i];
  } else if (args[i] === "--version" || args[i] === "-v") {
    process.stderr.write(`${config.SERVER_NAME} v${config.SERVER_VERSION}\n`);
    process.exit(0);
  }
}

const server = new McpProxyServer({
  storeDir: customStoreDir,
  upstreamCommand: customUpstreamCmd,
  upstreamArgs: customUpstreamArgs
});

const shutdown = () => {
  server.stop();
  process.exit(0);
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

server.start(process.stdin, process.stdout);
