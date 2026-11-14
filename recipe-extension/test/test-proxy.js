"use strict";

const assert = require("node:assert");
const { PassThrough } = require("node:stream");
const McpProxyServer = require("../src/proxy");
const FakeUpstreamServer = require("./fake-upstream");

async function runProxyCompatibilityTests() {
  console.log("▶ Running Test Suite: Upstream MCP Protocol & Tool Compatibility");

  // Create temporary in-memory proxy wired to FakeUpstream
  const proxy = new McpProxyServer({
    storeDir: "/tmp/test-mcp-recipes-" + Date.now(),
    sessionId: "test-session-proxy",
    upstreamCommand: "node",
    upstreamArgs: ["-e", "process.stdin.resume()"]
  });

  const fakeUpstream = new FakeUpstreamServer();

  // Intercept proxy's upstream write to feed fakeUpstream
  proxy._writeToUpstream = (msg) => {
    fakeUpstream.handleMessage(msg);
  };
  fakeUpstream.on("response", (res) => {
    proxy._handleUpstreamMessage(res);
  });

  const clientIn = new PassThrough();
  const clientOut = new PassThrough();
  proxy.start(clientIn, clientOut);

  const clientResponses = [];
  clientOut.on("data", chunk => {
    const lines = chunk.toString("utf8").split("\n").filter(Boolean);
    for (const l of lines) {
      clientResponses.push(JSON.parse(l));
    }
  });

  // Helper to send client message and wait for matching response ID
  const sendRequest = (method, params = {}, id = Math.floor(Math.random() * 10000)) => {
    return new Promise((resolve) => {
      const check = setInterval(() => {
        const found = clientResponses.find(r => r.id === id);
        if (found) {
          clearInterval(check);
          resolve(found);
        }
      }, 20);
      clientIn.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  };

  // Test 1: Initialize Handshake
  const initRes = await sendRequest("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "test-client", version: "1.0.0" }
  }, 1);

  assert.ok(initRes.result, "Initialize response must have result");
  assert.strictEqual(initRes.result.serverInfo.name, "mobile-mcp-recipe-server");
  assert.ok(initRes.result.instructions.includes("Mobile MCP Recipe Extension Active"), "Instructions must mention extension");
  console.log("  ✔ initialize handshake and instruction augmentation passed");

  // Test 2: Tools List preservation and extension tools
  const toolsListRes = await sendRequest("tools/list", {}, 2);
  const tools = toolsListRes.result.tools;
  assert.ok(Array.isArray(tools), "Tools must be an array");

  // Verify all upstream tools exist
  const toolNames = tools.map(t => t.name);
  assert.ok(toolNames.includes("mobile_list_available_devices"), "Must retain mobile_list_available_devices");
  assert.ok(toolNames.includes("mobile_list_elements_on_screen"), "Must retain mobile_list_elements_on_screen");
  assert.ok(toolNames.includes("mobile_click_on_screen_at_coordinates"), "Must retain mobile_click_on_screen_at_coordinates");
  assert.ok(toolNames.includes("mobile_clipboard"), "Must retain mobile_clipboard");

  // Verify recipe extension tools are present
  const requiredExtensionTools = [
    "mobile_recipe_list",
    "mobile_recipe_show",
    "mobile_recipe_run",
    "mobile_recipe_save",
    "mobile_recipe_delete",
    "mobile_guidance_list",
    "mobile_guidance_save",
    "mobile_helper_insert_text",
    "mobile_helper_thinking_state"
  ];
  for (const extTool of requiredExtensionTools) {
    assert.ok(toolNames.includes(extTool), `Extension tool '${extTool}' must be registered`);
  }
  console.log("  ✔ tools/list preserved upstream tools and registered all 10 extension tools");

  // Test 3: Upstream tool call passthrough
  const listDevicesRes = await sendRequest("tools/call", {
    name: "mobile_list_available_devices",
    arguments: {}
  }, 3);
  assert.ok(listDevicesRes.result, "Tool call must succeed");
  assert.ok(!listDevicesRes.result.isError, "Tool call result should not be an error");
  assert.ok(listDevicesRes.result.content[0].text.includes("Pixel 8 Pro"));
  console.log("  ✔ upstream tool call executed and returned faithful result");

  // Test 4: Unknown method returns JSON-RPC -32601 error
  const unknownMethodRes = await sendRequest("nonexistent/method", {}, 4);
  assert.ok(unknownMethodRes.error, "Must return error for unknown method");
  assert.strictEqual(unknownMethodRes.error.code, -32601);
  console.log("  ✔ unknown method returns standard JSON-RPC -32601 error");

  proxy.stop();
  console.log("✔ Suite 1: Upstream compatibility verified successfully\n");
}

module.exports = { runProxyCompatibilityTests };

if (require.main === module) {
  runProxyCompatibilityTests().catch(err => {
    console.error("Suite 1 failed:", err);
    process.exit(1);
  });
}
