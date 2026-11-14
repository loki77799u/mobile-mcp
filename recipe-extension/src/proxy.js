"use strict";

const { spawn } = require("node:child_process");
const EventEmitter = require("node:events");
const config = require("./config");
const RecipeStore = require("./store");
const RecipeRunner = require("./runner");
const GuidanceDeliveryManager = require("./guidance-delivery");
const AutomatedRecipeLearner = require("./learning");
const { insertTextVerified } = require("./helpers/text-insertion");
const { ensureThinkingState } = require("./helpers/chatgpt");
const audit = require("./audit");

class McpProxyServer extends EventEmitter {
  constructor(options = {}) {
    super();
    this.storeDir = options.storeDir || config.STORE_DIR;
    this.store = new RecipeStore(this.storeDir);
    this.store.seedDefaults();
    this.runner = new RecipeRunner(this.store);
    this.guidanceDelivery = new GuidanceDeliveryManager(this.store);
    this.learner = new AutomatedRecipeLearner(this.store);

    this.upstreamCommand = options.upstreamCommand || config.UPSTREAM_COMMAND;
    this.upstreamArgs = options.upstreamArgs || config.UPSTREAM_ARGS;
    this.upstreamProcess = null;

    // Upstream request/response tracking
    this.nextRequestId = 1;
    this.pendingUpstreamRequests = new Map(); // id -> { resolve, reject, timeout }

    // Session identification
    this.sessionId = options.sessionId || `session-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    this.clientTransportFormat = "unknown"; // "ndjson" | "content-length"

    // Inbound stdin buffer
    this.stdinBuffer = Buffer.alloc(0);
    this.upstreamStdoutBuffer = Buffer.alloc(0);
  }

  /**
   * Extension tool definitions added to tools/list
   */
  getExtensionToolDefinitions() {
    return [
      {
        name: "mobile_recipe_list",
        description: "List installed mobile app recipes with descriptions, parameters, and validation status (draft/validated/stale).",
        inputSchema: {
          type: "object",
          properties: {
            package_name: { type: "string", description: "Filter by Android package name (e.g. com.openai.chatgpt)" },
            validation_status: { type: "string", enum: ["draft", "validated", "stale"], description: "Filter by status" },
            query: { type: "string", description: "Search query in recipe name or description" }
          }
        }
      },
      {
        name: "mobile_recipe_show",
        description: "View full declarative recipe details: parameters, preconditions, steps, semantic selectors, and verification.",
        inputSchema: {
          type: "object",
          properties: {
            name: { type: "string", description: "Unique name of the recipe to inspect" }
          },
          required: ["name"]
        }
      },
      {
        name: "mobile_recipe_run",
        description: "Execute a declarative, parameterized workflow recipe with fresh accessibility selector resolution, bounded wait verification, and safe submission handling.",
        inputSchema: {
          type: "object",
          properties: {
            recipe: { type: "string", description: "Recipe name" },
            device: { type: "string", description: "Target mobile device identifier" },
            params: { type: "object", description: "Parameter values for substitution" }
          },
          required: ["recipe", "device"]
        }
      },
      {
        name: "mobile_recipe_save",
        description: "Save or update a declarative recipe JSON. Enforces strict schema, parameter validation, and provenance tracking. Defaults to 'draft' status.",
        inputSchema: {
          type: "object",
          properties: {
            recipe_json: { type: "string", description: "Complete recipe JSON string" },
            mark_validated: { type: "boolean", description: "Set validation status to 'validated' (default is draft)" }
          },
          required: ["recipe_json"]
        }
      },
      {
        name: "mobile_recipe_delete",
        description: "Explicitly delete a recipe by name.",
        inputSchema: {
          type: "object",
          properties: {
            name: { type: "string", description: "Name of the recipe to delete" }
          },
          required: ["name"]
        }
      },
      {
        name: "mobile_recipe_auto_learn",
        description: "Synthesize and save an automated declarative workflow recipe from the actions performed in this turn. Generalizes text inputs into parameters and matches elements with semantic selectors.",
        inputSchema: {
          type: "object",
          properties: {
            name: { type: "string", description: "Optional custom name for the recipe" },
            description: { type: "string", description: "Optional description of what the workflow achieved" }
          }
        }
      },
      {
        name: "mobile_guidance_list",
        description: "List compact app-specific operational guidance, known quirks, and semantic selectors for an Android package.",
        inputSchema: {
          type: "object",
          properties: {
            package_name: { type: "string", description: "Filter by app package name (e.g. com.openai.chatgpt). If omitted, lists all packages with guidance." }
          }
        }
      },
      {
        name: "mobile_guidance_save",
        description: "Save or update operational guidance for an app package.",
        inputSchema: {
          type: "object",
          properties: {
            guidance_json: { type: "string", description: "Guidance JSON string containing package_name and guidance string array" }
          },
          required: ["guidance_json"]
        }
      },
      {
        name: "mobile_helper_insert_text",
        description: "Exact verified text insertion. Checks focus on the actual editable node, uses exact clipboard paste (preventing mobile_type_keys spacing bugs), and verifies character-for-character readback.",
        inputSchema: {
          type: "object",
          properties: {
            device: { type: "string", description: "Device ID" },
            text: { type: "string", description: "Exact text to insert" },
            target_selector: { type: "object", description: "Optional semantic selector for target editable field" },
            clear_first: { type: "boolean", description: "Clear field before pasting (default false)" }
          },
          required: ["device", "text"]
        }
      },
      {
        name: "mobile_helper_thinking_state",
        description: "Checks and verifies ChatGPT Android Thinking Mode state in composer prior to message submission (handles Free plan auto-reset).",
        inputSchema: {
          type: "object",
          properties: {
            device: { type: "string", description: "Device ID" },
            desired_state: { type: "string", enum: ["on", "off"], description: "Desired state (default: on)" }
          },
          required: ["device"]
        }
      }
    ];
  }

  /**
   * Start proxy server. Spawns upstream process and attaches stdio streams.
   */
  start(inStream = process.stdin, outStream = process.stdout) {
    this.inStream = inStream;
    this.outStream = outStream;

    // Start upstream process if not already set (e.g. in test mode a mock process may be provided)
    if (!this.upstreamProcess) {
      this._startUpstreamProcess();
    }

    // Handle client stdin
    this.inStream.on("data", chunk => this._handleClientData(chunk));
    this.inStream.on("end", () => this.stop());

    process.stderr.write(`[mobile-mcp-recipe-server] Proxy started (session: ${this.sessionId})\n`);
  }

  stop() {
    if (this.upstreamProcess) {
      try {
        this.upstreamProcess.kill("SIGTERM");
      } catch {}
      this.upstreamProcess = null;
    }
  }

  _startUpstreamProcess() {
    process.stderr.write(`[mobile-mcp-recipe-server] Spawning upstream: ${this.upstreamCommand} ${this.upstreamArgs.join(" ")}\n`);
    this.upstreamProcess = spawn(this.upstreamCommand, this.upstreamArgs, {
      stdio: ["pipe", "pipe", "inherit"],
      env: { ...process.env }
    });

    this.upstreamProcess.stdout.on("data", chunk => this._handleUpstreamData(chunk));
    this.upstreamProcess.on("exit", (code, signal) => {
      process.stderr.write(`[mobile-mcp-recipe-server] Upstream process exited (code=${code}, signal=${signal})\n`);
    });
    this.upstreamProcess.on("error", err => {
      process.stderr.write(`[mobile-mcp-recipe-server] Upstream error: ${err.message}\n`);
    });
  }

  /**
   * Internal tool invoker used by recipe runner and helpers to call upstream tools.
   */
  async invokeTool(toolName, args = {}) {
    const id = `internal-${this.nextRequestId++}`;
    const message = {
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params: {
        name: toolName,
        arguments: args
      }
    };

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingUpstreamRequests.delete(id);
        reject(new Error(`Upstream tool call '${toolName}' timed out after 30s`));
      }, 30000);

      this.pendingUpstreamRequests.set(id, {
        resolve: res => {
          clearTimeout(timeout);
          // Standard tool result content unpacking
          if (res && res.content && Array.isArray(res.content)) {
            const textPart = res.content.find(c => c.type === "text");
            if (textPart) {
              resolve(textPart.text);
              return;
            }
          }
          resolve(res);
        },
        reject: err => {
          clearTimeout(timeout);
          reject(err);
        }
      });

      this._writeToUpstream(message);
    });
  }

  // --------------------------------------------------------------------------
  // Message Parsing & Serialization
  // --------------------------------------------------------------------------

  _handleClientData(chunk) {
    this.stdinBuffer = Buffer.concat([this.stdinBuffer, chunk]);
    this._processBuffer(this.stdinBuffer, (msg, remaining) => {
      this.stdinBuffer = remaining;
      this._handleClientMessage(msg);
    });
  }

  _handleUpstreamData(chunk) {
    this.upstreamStdoutBuffer = Buffer.concat([this.upstreamStdoutBuffer, chunk]);
    this._processBuffer(this.upstreamStdoutBuffer, (msg, remaining) => {
      this.upstreamStdoutBuffer = remaining;
      this._handleUpstreamMessage(msg);
    });
  }

  _processBuffer(buf, onMessage) {
    let currentBuf = buf;
    while (currentBuf.length > 0) {
      // 1. Check for Content-Length framing: "Content-Length: N\r\n\r\n"
      if (currentBuf.slice(0, 15).toString("utf8").toLowerCase().startsWith("content-length:")) {
        this.clientTransportFormat = "content-length";
        const headerEnd = currentBuf.indexOf("\r\n\r\n");
        if (headerEnd === -1) break; // Incomplete header

        const headerStr = currentBuf.slice(0, headerEnd).toString("utf8");
        const match = headerStr.match(/content-length:\s*(\d+)/i);
        if (!match) {
          process.stderr.write(`[proxy] Corrupt Content-Length header: ${headerStr}\n`);
          currentBuf = currentBuf.slice(headerEnd + 4);
          continue;
        }

        const contentLength = parseInt(match[1], 10);
        const bodyStart = headerEnd + 4;
        const totalLength = bodyStart + contentLength;

        if (currentBuf.length < totalLength) {
          break; // Incomplete body
        }

        const bodyBuf = currentBuf.slice(bodyStart, totalLength);
        currentBuf = currentBuf.slice(totalLength);

        try {
          const parsed = JSON.parse(bodyBuf.toString("utf8"));
          onMessage(parsed, currentBuf);
        } catch (err) {
          process.stderr.write(`[proxy] JSON decode error in Content-Length body: ${err.message}\n`);
        }
      } else {
        // 2. NDJSON framing (line-delimited)
        this.clientTransportFormat = "ndjson";
        const newlineIdx = currentBuf.indexOf("\n");
        if (newlineIdx === -1) break; // Incomplete line

        const line = currentBuf.slice(0, newlineIdx).toString("utf8").trim();
        currentBuf = currentBuf.slice(newlineIdx + 1);

        if (line.length > 0) {
          try {
            const parsed = JSON.parse(line);
            onMessage(parsed, currentBuf);
          } catch (err) {
            process.stderr.write(`[proxy] JSON decode error in NDJSON line: ${err.message}\n`);
          }
        }
      }
    }
  }

  _writeToClient(message) {
    const jsonStr = JSON.stringify(message);
    const data = Buffer.from(jsonStr, "utf8");

    if (this.clientTransportFormat === "content-length") {
      const header = `Content-Length: ${data.length}\r\n\r\n`;
      this.outStream.write(Buffer.concat([Buffer.from(header, "utf8"), data]));
    } else {
      this.outStream.write(Buffer.concat([data, Buffer.from("\n", "utf8")]));
    }
  }

  _writeToUpstream(message) {
    if (!this.upstreamProcess || !this.upstreamProcess.stdin.writable) {
      process.stderr.write(`[proxy] Cannot write to upstream: stdin not writable\n`);
      return;
    }
    const jsonStr = JSON.stringify(message);
    const data = Buffer.from(jsonStr + "\n", "utf8");
    this.upstreamProcess.stdin.write(data);
  }

  // --------------------------------------------------------------------------
  // Client Request Handling
  // --------------------------------------------------------------------------

  async _handleClientMessage(msg) {
    if (!msg || typeof msg !== "object") return;

    const id = msg.id;
    const method = msg.method;
    const params = msg.params || {};

    // 1. Initialize
    if (method === "initialize") {
      this._handleClientInitialize(id, params);
      return;
    }

    // 2. Tools list
    if (method === "tools/list") {
      this._handleClientToolsList(id, params);
      return;
    }

    // 3. Tools call
    if (method === "tools/call") {
      this._handleClientToolsCall(id, params);
      return;
    }

    // 4. Notifications or other methods: forward to upstream
    if (id !== undefined) {
      // Track response
      this.pendingUpstreamRequests.set(id, {
        resolve: result => {
          this._writeToClient({ jsonrpc: "2.0", id, result });
        },
        reject: error => {
          this._writeToClient({ jsonrpc: "2.0", id, error });
        }
      });
    }

    this._writeToUpstream(msg);
  }

  _handleClientInitialize(id, params) {
    // Intercept initialize: forward to upstream, enhance instructions
    this.pendingUpstreamRequests.set(id, {
      resolve: upstreamResult => {
        const enhancedInstructions = (upstreamResult.instructions || "") +
          "\n\n[Mobile MCP Recipe Extension Active]\n" +
          "When app-specific workflows are learned, they are centrally stored in ~/.mobile-mcp/recipes.\n" +
          "Relevant guidance and recipes are automatically surfaced on tool calls when an app is detected.\n" +
          "Available recipe tools: mobile_recipe_list, mobile_recipe_show, mobile_recipe_run, mobile_recipe_save, mobile_recipe_delete, mobile_recipe_auto_learn, mobile_guidance_list, mobile_guidance_save, mobile_helper_insert_text, mobile_helper_thinking_state.";

        const mergedResult = {
          ...upstreamResult,
          serverInfo: {
            name: config.SERVER_NAME,
            version: config.SERVER_VERSION
          },
          instructions: enhancedInstructions
        };

        this._writeToClient({
          jsonrpc: "2.0",
          id,
          result: mergedResult
        });
      },
      reject: err => {
        this._writeToClient({
          jsonrpc: "2.0",
          id,
          error: { code: -32603, message: err.message || "Upstream initialize error" }
        });
      }
    });

    this._writeToUpstream({
      jsonrpc: "2.0",
      id,
      method: "initialize",
      params
    });
  }

  _handleClientToolsList(id, params) {
    this.pendingUpstreamRequests.set(id, {
      resolve: upstreamResult => {
        const upstreamTools = (upstreamResult && Array.isArray(upstreamResult.tools))
          ? upstreamResult.tools
          : [];

        const extensionTools = this.getExtensionToolDefinitions();
        const mergedTools = [...upstreamTools, ...extensionTools];

        this._writeToClient({
          jsonrpc: "2.0",
          id,
          result: { tools: mergedTools }
        });
      },
      reject: err => {
        // Fallback: return at least our extension tools
        this._writeToClient({
          jsonrpc: "2.0",
          id,
          result: { tools: this.getExtensionToolDefinitions() }
        });
      }
    });

    this._writeToUpstream({
      jsonrpc: "2.0",
      id,
      method: "tools/list",
      params
    });
  }

  async _handleClientToolsCall(id, params) {
    const toolName = params.name;
    const toolArgs = params.arguments || {};

    // Dispatch extension tools locally
    if (toolName.startsWith("mobile_recipe_") || toolName.startsWith("mobile_guidance_") || toolName.startsWith("mobile_helper_")) {
      try {
        const result = await this._dispatchExtensionTool(toolName, toolArgs);
        this.learner.observe(this.sessionId, toolName, toolArgs, result);
        this._writeToClient({
          jsonrpc: "2.0",
          id,
          result: {
            content: [{ type: "text", text: typeof result === "string" ? result : JSON.stringify(result, null, 2) }],
            isError: result && result.success === false
          }
        });
      } catch (err) {
        this._writeToClient({
          jsonrpc: "2.0",
          id,
          result: {
            content: [{ type: "text", text: JSON.stringify({ success: false, error: err.message }, null, 2) }],
            isError: true
          }
        });
      }
      return;
    }

    // Upstream tool: forward to upstream, then apply guidance delivery augmentation
    this.pendingUpstreamRequests.set(id, {
      resolve: upstreamResult => {
        try {
          this.learner.observe(this.sessionId, toolName, toolArgs, upstreamResult);
          const augmented = this.guidanceDelivery.augmentResponseIfNeeded(
            toolName,
            toolArgs,
            upstreamResult,
            { sessionId: this.sessionId, deviceId: toolArgs.device }
          );
          this._writeToClient({ jsonrpc: "2.0", id, result: augmented });
        } catch (err) {
          // If augmentation fails, preserve unmodified upstream result
          this._writeToClient({ jsonrpc: "2.0", id, result: upstreamResult });
        }
      },
      reject: err => {
        this._writeToClient({
          jsonrpc: "2.0",
          id,
          error: { code: -32603, message: err.message || "Upstream tool call failed" }
        });
      }
    });

    this._writeToUpstream({
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params
    });
  }

  /**
   * Dispatches local extension tools.
   */
  async _dispatchExtensionTool(name, args) {
    switch (name) {
      case "mobile_recipe_list": {
        const recipes = this.store.listRecipes({
          package_name: args.package_name,
          validation_status: args.validation_status,
          query: args.query
        });
        return {
          success: true,
          count: recipes.length,
          recipes
        };
      }

      case "mobile_recipe_show": {
        if (!args.name) throw new Error("Missing 'name' argument");
        const recipe = this.store.getRecipe(args.name);
        if (!recipe) {
          return { success: false, error: `Recipe '${args.name}' not found in store` };
        }
        return { success: true, recipe };
      }

      case "mobile_recipe_run": {
        if (!args.recipe) throw new Error("Missing 'recipe' argument");
        if (!args.device) throw new Error("Missing 'device' argument");
        const recipe = this.store.getRecipe(args.recipe);
        if (!recipe) {
          return { success: false, error: `Recipe '${args.recipe}' not found` };
        }
        const runResult = await this.runner.run(
          (tName, tArgs) => this.invokeTool(tName, tArgs),
          recipe,
          args.params || {},
          args.device
        );
        return runResult;
      }

      case "mobile_recipe_save": {
        if (!args.recipe_json) throw new Error("Missing 'recipe_json' argument");
        const parsed = JSON.parse(args.recipe_json);
        if (args.mark_validated) {
          parsed.validation_status = "validated";
        }
        const saveRes = this.store.saveRecipe(parsed, {
          sessionId: this.sessionId,
          clientName: "mcp-client"
        });
        return saveRes;
      }

      case "mobile_recipe_delete": {
        if (!args.name) throw new Error("Missing 'name' argument");
        const deleted = this.store.deleteRecipe(args.name);
        return {
          success: deleted,
          deleted: args.name,
          error: deleted ? undefined : `Recipe '${args.name}' not found`
        };
      }

      case "mobile_recipe_auto_learn": {
        const synthesized = this.learner.synthesizeRecipe(this.sessionId, {
          name: args.name,
          description: args.description
        });
        if (!synthesized) {
          return {
            success: false,
            message: "Insufficient actions recorded to synthesize a recipe (minimum 2 interactive steps required)."
          };
        }
        return {
          success: true,
          recipe_name: synthesized.name,
          package_name: synthesized.package_name,
          steps_count: synthesized.steps.length,
          validation_status: synthesized.validation_status,
          note: "Recipe successfully synthesized and saved to store. It will be surfaced automatically on future turns with this app."
        };
      }

      case "mobile_guidance_list": {
        if (args.package_name) {
          const doc = this.store.getGuidance(args.package_name);
          return {
            success: Boolean(doc),
            package_name: args.package_name,
            guidance_doc: doc || null,
            error: doc ? undefined : `No guidance found for package '${args.package_name}'`
          };
        }
        const all = this.store.listGuidance();
        return {
          success: true,
          packages: all
        };
      }

      case "mobile_guidance_save": {
        if (!args.guidance_json) throw new Error("Missing 'guidance_json' argument");
        const parsed = JSON.parse(args.guidance_json);
        const saveRes = this.store.saveGuidance(parsed);
        return saveRes;
      }

      case "mobile_helper_insert_text": {
        const res = await insertTextVerified(
          (tName, tArgs) => this.invokeTool(tName, tArgs),
          args
        );
        return res;
      }

      case "mobile_helper_thinking_state": {
        const res = await ensureThinkingState(
          (tName, tArgs) => this.invokeTool(tName, tArgs),
          args
        );
        return res;
      }

      default:
        throw new Error(`Unknown extension tool: ${name}`);
    }
  }

  // --------------------------------------------------------------------------
  // Upstream Response Handling
  // --------------------------------------------------------------------------

  _handleUpstreamMessage(msg) {
    if (!msg || typeof msg !== "object") return;

    const id = msg.id;

    // Check if this response answers a pending request from proxy or client
    if (id !== undefined && this.pendingUpstreamRequests.has(id)) {
      const handler = this.pendingUpstreamRequests.get(id);
      this.pendingUpstreamRequests.delete(id);

      if (msg.error) {
        handler.reject(msg.error);
      } else {
        handler.resolve(msg.result);
      }
      return;
    }

    // Pass through unprompted notifications from upstream to client
    this._writeToClient(msg);
  }
}

module.exports = McpProxyServer;
