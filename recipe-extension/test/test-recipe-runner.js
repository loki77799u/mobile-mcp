"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const RecipeRunner = require("../src/runner");
const RecipeStore = require("../src/store");
const FakeUpstreamServer = require("./fake-upstream");

async function runRecipeRunnerTests() {
  console.log("▶ Running Test Suite: Declarative Recipe Execution & Safety Boundaries");

  const testStoreDir = path.join("/tmp", "test-runner-" + Date.now());
  const store = new RecipeStore(testStoreDir);
  store.seedDefaults();

  const runner = new RecipeRunner(store);
  const fakeUpstream = new FakeUpstreamServer();
  const mockInvoker = async (tName, tArgs) => fakeUpstream.dispatchTool(tName, tArgs);

  const device = "test-device-1";

  // Test 1: Full verified recipe execution with parameter substitution
  const sendPromptRecipe = store.getRecipe("chatgpt-send-prompt");
  assert.ok(sendPromptRecipe, "chatgpt-send-prompt recipe must exist in seeded store");

  const runResult1 = await runner.run(
    mockInvoker,
    sendPromptRecipe,
    {
      prompt_text: "Stand in: ask for a raise.",
      thinking_mode: "on"
    },
    device
  );

  assert.strictEqual(runResult1.success, true, "Recipe execution must succeed");
  assert.strictEqual(runResult1.recipe, "chatgpt-send-prompt");
  assert.strictEqual(runResult1.steps_completed, 2);
  assert.strictEqual(fakeUpstream.editTextValue, "Stand in: ask for a raise.");
  assert.strictEqual(fakeUpstream.thinkingState, "on");
  console.log("  ✔ parameterized declarative recipe executed and verified end-to-end");

  // Test 2: Ambiguous selector failure
  const ambiguousRecipe = {
    schema_version: 2,
    name: "test-ambiguous",
    description: "Tests ambiguous selector handling",
    package_name: "com.openai.chatgpt",
    steps: [
      {
        id: 1,
        action: "click",
        note: "Click View (matches many views)",
        target_selector: { role: "View" } // Matches multiple views!
      }
    ]
  };

  const ambResult = await runner.run(mockInvoker, ambiguousRecipe, {}, device);
  assert.strictEqual(ambResult.success, false, "Must fail on ambiguous selector");
  assert.ok(ambResult.error.includes("Ambiguous selector matched"), "Must report ambiguous selector diagnostic");
  console.log("  ✔ ambiguous selector halted execution before mis-clicking");

  // Test 3: Missing selector / UI change failure
  const missingRecipe = {
    schema_version: 2,
    name: "test-missing-selector",
    description: "Tests missing selector",
    package_name: "com.openai.chatgpt",
    steps: [
      {
        id: 1,
        action: "click",
        target_selector: { text: "Nonexistent Submit Button" }
      }
    ]
  };
  const missingResult = await runner.run(mockInvoker, missingRecipe, {}, device);
  assert.strictEqual(missingResult.success, false);
  assert.ok(missingResult.error.includes("No element matched selector"), "Must report missing selector error");
  console.log("  ✔ missing selector stopped execution with clear diagnostic");

  // Test 4: Bounded wait timeout
  const timeoutRecipe = {
    schema_version: 2,
    name: "test-wait-timeout",
    description: "Tests bounded wait timeout",
    package_name: "com.openai.chatgpt",
    steps: [
      {
        id: 1,
        action: "wait",
        params: {
          condition: "element_exists",
          value: "Element That Will Never Appear",
          timeout_ms: "500" // 500ms bounded wait
        }
      }
    ]
  };
  const waitStart = Date.now();
  const timeoutResult = await runner.run(mockInvoker, timeoutRecipe, {}, device);
  const waitElapsed = Date.now() - waitStart;
  assert.strictEqual(timeoutResult.success, false);
  assert.ok(timeoutResult.error.includes("timed out after 500ms"));
  assert.ok(waitElapsed >= 400 && waitElapsed <= 2000, `Wait must terminate promptly around timeout (took ${waitElapsed}ms)`);
  console.log("  ✔ bounded wait condition timed out predictably without indefinite blocking");

  // Test 5: Uncertain submission outcome MUST NOT auto-retry
  let sendClickCount = 0;
  const originalDispatch = fakeUpstream.dispatchTool.bind(fakeUpstream);
  fakeUpstream.dispatchTool = (tName, tArgs) => {
    if (tName === "mobile_click_on_screen_at_coordinates") {
      sendClickCount++;
      // Simulate submission network hang / ambiguous failure
      return { content: [{ type: "text", text: "Timeout communicating with upstream app" }], isError: true };
    }
    return originalDispatch(tName, tArgs);
  };

  const uncertainSubmissionRecipe = {
    schema_version: 2,
    name: "test-submission-safety",
    description: "Tests submission safety policy",
    package_name: "com.openai.chatgpt",
    steps: [
      {
        id: 1,
        action: "click",
        is_submission: true, // Marked as submission step
        note: "Send message to ChatGPT",
        target_selector: { role: "EditText" }
      }
    ]
  };

  const submissionResult = await runner.run(mockInvoker, uncertainSubmissionRecipe, {}, device);
  assert.strictEqual(submissionResult.success, false);
  assert.strictEqual(submissionResult.ambiguous_submission, true, "Must flag ambiguous_submission");
  assert.strictEqual(sendClickCount, 1, "Must NEVER auto-retry an uncertain submission");
  assert.ok(submissionResult.error.includes("Automatic retry is strictly prohibited"), "Must state prohibition of duplicate send");
  console.log("  ✔ uncertain submission safely halted without duplicate send attempts");

  // Clean up
  fs.rmSync(testStoreDir, { recursive: true, force: true });
  console.log("✔ Suite 4: Declarative recipe runner passed all safety and verification tests\n");
}

module.exports = { runRecipeRunnerTests };

if (require.main === module) {
  runRecipeRunnerTests().catch(err => {
    console.error("Suite 4 failed:", err);
    process.exit(1);
  });
}
