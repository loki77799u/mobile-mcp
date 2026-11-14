"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const RecipeStore = require("../src/store");
const GuidanceDeliveryManager = require("../src/guidance-delivery");

async function runGuidanceDeliveryTests() {
  console.log("▶ Running Test Suite: Context-Aware Guidance Delivery & Deduplication");

  const testStoreDir = path.join("/tmp", "test-guidance-" + Date.now());
  const store = new RecipeStore(testStoreDir);
  store.seedDefaults();

  const manager = new GuidanceDeliveryManager(store);

  const sessionId1 = "session-codex-1";
  const sessionId2 = "session-claude-2";
  const deviceId = "device-pixel8";

  // Test 1: Relevant recipe delivery for relevant package
  const chatgptLaunchArgs = { device: deviceId, packageName: "com.openai.chatgpt" };
  const mockUpstreamResponse = {
    content: [{ type: "text", text: "App com.openai.chatgpt launched." }],
    isError: false
  };

  const augmented1 = manager.augmentResponseIfNeeded("mobile_launch_app", chatgptLaunchArgs, mockUpstreamResponse, {
    sessionId: sessionId1,
    deviceId
  });

  const augmentedText1 = augmented1.content[0].text;
  assert.ok(augmentedText1.includes("App com.openai.chatgpt launched."), "Must preserve upstream content");
  assert.ok(augmentedText1.includes("[Mobile Recipe Advisory: App 'com.openai.chatgpt']"), "Must append recipe advisory for ChatGPT");
  assert.ok(augmentedText1.includes("mobile_type_keys once changed 'v1.2' to 'v1. 2'"), "Must include seeded guidance observation");
  assert.ok(augmentedText1.includes("chatgpt-verified-paste"), "Must include available recipe summary");
  console.log("  ✔ relevant recipe delivery triggered on relevant app detection");

  // Test 2: Deduplication within same session/device/package
  // Subsequent tool call in the same session should NOT repeat the guidance text
  const nextCallResponse = {
    content: [{ type: "text", text: "Element list on screen" }],
    isError: false
  };
  const augmented2 = manager.augmentResponseIfNeeded("mobile_list_elements_on_screen", { device: deviceId }, nextCallResponse, {
    sessionId: sessionId1,
    deviceId
  });
  assert.strictEqual(augmented2.content[0].text, "Element list on screen", "Must deduplicate: no advisory on subsequent call in same session");
  console.log("  ✔ deduplication within session scope verified (zero redundant token overhead)");

  // Test 3: Unrelated app gets ZERO recipe/guidance content
  const settingsLaunchArgs = { device: deviceId, packageName: "com.android.settings" };
  const settingsResponse = {
    content: [{ type: "text", text: "Settings opened" }],
    isError: false
  };
  const augmentedSettings = manager.augmentResponseIfNeeded("mobile_launch_app", settingsLaunchArgs, settingsResponse, {
    sessionId: sessionId1,
    deviceId
  });
  assert.strictEqual(augmentedSettings.content[0].text, "Settings opened", "Unrelated apps must receive zero recipe content");
  console.log("  ✔ unrelated tasks receive zero recipe overhead");

  // Test 4: Recipe updates trigger re-delivery
  // If guidance or recipes are saved, store version bumps, allowing updated advisory
  store.saveGuidance({
    package_name: "com.openai.chatgpt",
    guidance: ["Updated rule: always verify focus on EditText"]
  });

  const postUpdateResponse = {
    content: [{ type: "text", text: "Foreground app is com.openai.chatgpt" }],
    isError: false
  };
  const augmentedPostUpdate = manager.augmentResponseIfNeeded("mobile_get_foreground_app", { device: deviceId }, postUpdateResponse, {
    sessionId: sessionId1,
    deviceId
  });
  assert.ok(augmentedPostUpdate.content[0].text.includes("Updated rule: always verify focus on EditText"), "Must re-deliver updated guidance when store version updates");
  console.log("  ✔ recipe/guidance updates automatically re-deliver to client");

  // Test 5: Client restart isolation (new session ID receives advisory)
  const restartResponse = {
    content: [{ type: "text", text: "App started" }],
    isError: false
  };
  const augmentedRestart = manager.augmentResponseIfNeeded("mobile_launch_app", chatgptLaunchArgs, restartResponse, {
    sessionId: "new-restarted-session-3",
    deviceId
  });
  assert.ok(augmentedRestart.content[0].text.includes("[Mobile Recipe Advisory: App 'com.openai.chatgpt']"), "Client restart must receive fresh advisory");
  console.log("  ✔ client restart isolation verified");

  // Test 6: Concurrent-client isolation
  // sessionId2 (independent client) must receive its own advisory even though sessionId1 already saw it
  const augmentedClient2 = manager.augmentResponseIfNeeded("mobile_launch_app", chatgptLaunchArgs, mockUpstreamResponse, {
    sessionId: sessionId2,
    deviceId
  });
  assert.ok(augmentedClient2.content[0].text.includes("[Mobile Recipe Advisory: App 'com.openai.chatgpt']"), "Independent client session must receive advisory");
  console.log("  ✔ concurrent client isolation verified");

  // Test 7: Confidential task data safety in deduplication keys
  const safeKey = manager.getDeduplicationKey(sessionId1, deviceId, "com.openai.chatgpt", "hash123");
  assert.strictEqual(safeKey, "session-codex-1::device-pixel8::com.openai.chatgpt::hash123");
  assert.ok(!safeKey.includes("password") && !safeKey.includes("secret"), "Deduplication keys must contain no task content");
  console.log("  ✔ deduplication key confidentiality verified");

  // Clean up
  fs.rmSync(testStoreDir, { recursive: true, force: true });
  console.log("✔ Suite 2: Context-aware guidance delivery verified successfully\n");
}

module.exports = { runGuidanceDeliveryTests };

if (require.main === module) {
  runGuidanceDeliveryTests().catch(err => {
    console.error("Suite 2 failed:", err);
    process.exit(1);
  });
}
