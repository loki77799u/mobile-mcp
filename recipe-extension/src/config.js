"use strict";

const path = require("node:path");
const os = require("node:os");

const HOME_DIR = os.homedir();
const DEFAULT_STORE_DIR = process.env.MOBILE_MCP_RECIPES_DIR || path.join(HOME_DIR, ".mobile-mcp", "recipes");
const DEFAULT_DEFAULT_RECIPES_DIR = path.join(__dirname, "..", "default-recipes");

// Upstream Mobile MCP execution settings
// If MOBILE_MCP_DIRECT_PATH is set or an npx cached bundle exists, we can use it, or default to npx
const UPSTREAM_COMMAND = process.env.UPSTREAM_MCP_COMMAND || "npx";
const UPSTREAM_ARGS = process.env.UPSTREAM_MCP_ARGS 
  ? (typeof process.env.UPSTREAM_MCP_ARGS === "string" && process.env.UPSTREAM_MCP_ARGS.startsWith("[")
      ? JSON.parse(process.env.UPSTREAM_MCP_ARGS)
      : process.env.UPSTREAM_MCP_ARGS.split(" "))
  : ["-y", "@mobilenext/mobile-mcp@1.0.17"]; // pinned: bump deliberately after re-running tests

module.exports = {
  SERVER_NAME: "mobile-mcp-recipe-server",
  SERVER_VERSION: "1.0.0",
  STORE_DIR: DEFAULT_STORE_DIR,
  RECIPES_DIR: path.join(DEFAULT_STORE_DIR, "recipes"),
  GUIDANCE_DIR: path.join(DEFAULT_STORE_DIR, "guidance"),
  AUDIT_LOG_FILE: path.join(DEFAULT_STORE_DIR, "audit.log"),
  BUNDLED_RECIPES_DIR: path.join(DEFAULT_DEFAULT_RECIPES_DIR, "recipes"),
  BUNDLED_GUIDANCE_DIR: path.join(DEFAULT_DEFAULT_RECIPES_DIR, "guidance"),
  UPSTREAM_COMMAND,
  UPSTREAM_ARGS,
  DEFAULTS: {
    STEP_TIMEOUT_MS: 10000,
    MAX_STEP_TIMEOUT_MS: 60000,
    POLL_INTERVAL_MS: 400,
    MAX_RETRIES: 3,
    MAX_DIFF_DISPLAY_LEN: 200,
    SESSION_GUIDANCE_TTL_MS: 3600000 // 1 hour session deduplication cache
  }
};
