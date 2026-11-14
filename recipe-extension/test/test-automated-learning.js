"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const RecipeStore = require("../src/store");
const AutomatedRecipeLearner = require("../src/learning");
const GuidanceDeliveryManager = require("../src/guidance-delivery");

async function runAutomatedLearningTests() {
  console.log("▶ Running Test Suite: Automated Recipe Learning & Auto-Delivery Pipeline");

  const testStoreDir = path.join("/tmp", "test-learning-" + Date.now());
  const store = new RecipeStore(testStoreDir);
  store.seedDefaults();

  const learner = new AutomatedRecipeLearner(store);
  const guidance = new GuidanceDeliveryManager(store);

  const sessionId = "session-learner-turn-1";
  const device = "device-pixel8";

  // Step 1: Agent launches ChatGPT
  learner.observe(sessionId, "mobile_launch_app", { device, packageName: "com.openai.chatgpt" }, {
    content: [{ type: "text", text: "Launched" }]
  });

  // Step 2: Agent reads screen elements
  const mockTreeText = `One element per line: @ref Type text= label= name= value= id= at=x,y size=WxH [focused] [selected] [checked] [disabled]
@e1 LinearLayout id="com.openai.chatgpt:id/action_bar_root" at=0,0 size=1008x2244
@e40 View label="Reply to ChatGPT" at=209,2065 size=712x62
@e41 EditText at=209,2035 size=712x122
@e43 View label="Attachment" at=118,2066 size=61x61`;

  learner.observe(sessionId, "mobile_list_elements_on_screen", { device }, {
    content: [{ type: "text", text: mockTreeText }]
  });

  // Step 3: Agent clicks Attachment button (at=118,2066)
  learner.observe(sessionId, "mobile_click_on_screen_at_coordinates", { device, x: 130, y: 2080 }, {
    content: [{ type: "text", text: "Clicked" }]
  });

  // Step 4: Agent inserts text into field
  learner.observe(sessionId, "mobile_helper_insert_text", {
    device,
    text: "Stand in: ask for a raise."
  }, {
    success: true,
    verified: true
  });

  // Step 5: Turn completes -> Trigger Automated Synthesis
  const synthesized = learner.synthesizeRecipe(sessionId, {
    name: "chatgpt-learned-raise-workflow",
    description: "Automated workflow learned from agent turn for asking for a raise"
  });

  assert.ok(synthesized, "Learner must synthesize a recipe from observed actions");
  assert.strictEqual(synthesized.schema_version, 2);
  assert.strictEqual(synthesized.name, "chatgpt-learned-raise-workflow");
  assert.strictEqual(synthesized.package_name, "com.openai.chatgpt");
  assert.strictEqual(synthesized.validation_status, "draft", "Automated recipes must default to draft");
  assert.strictEqual(synthesized.steps.length, 2);

  // Check step 1: correlated coordinates to semantic selector "Attachment"
  assert.strictEqual(synthesized.steps[0].action, "click");
  assert.strictEqual(synthesized.steps[0].target_selector.label, "Attachment");

  // Check step 2: text generalized into parameters
  assert.strictEqual(synthesized.steps[1].action, "helper_insert_text");
  assert.ok(synthesized.params.input_text_1, "Must extract generalized parameter");
  assert.strictEqual(synthesized.steps[1].params.text, "{{input_text_1}}");
  console.log("  ✔ automated recipe synthesized with semantic selectors and generalized parameters");

  // Step 6: Verify persistence in durable store
  const savedInStore = store.getRecipe("chatgpt-learned-raise-workflow");
  assert.ok(savedInStore, "Synthesized recipe must be saved in durable store");
  assert.strictEqual(savedInStore.validation_status, "draft");
  console.log("  ✔ synthesized recipe persisted in durable store");

  // Step 7: Verify automatic guidance delivery for future turns/sessions
  // Next time an agent (in a fresh turn or another client session) opens ChatGPT:
  const freshSessionId = "session-codex-future-turn";
  const launchRes = { content: [{ type: "text", text: "App started" }], isError: false };
  const augmentedFuture = guidance.augmentResponseIfNeeded(
    "mobile_launch_app",
    { device, packageName: "com.openai.chatgpt" },
    launchRes,
    { sessionId: freshSessionId, deviceId: device }
  );

  const advisoryText = augmentedFuture.content[0].text;
  assert.ok(advisoryText.includes("chatgpt-learned-raise-workflow"), "Newly learned recipe must be automatically surfaced to future sessions");
  console.log("  ✔ newly learned recipe automatically surfaced in guidance advisory for future turns");

  // Step 8: Tap-then-type learns the tapped field (not the stale tree's focus), keeps short
  // literals, carries submit, and falls back to coordinates for unlabeled taps
  const notesTree = (bodyFocused) => `One element per line: @ref Type text= label= name= value= id= at=x,y size=WxH [focused] [selected] [checked] [disabled]
@e1 LinearLayout id="com.example.notes:id/root" at=0,0 size=1000x2000
@e2 EditText label="Title" id="com.example.notes:id/title" at=50,100 size=900x100${bodyFocused ? "" : " [focused]"}
@e3 EditText label="Note body" id="com.example.notes:id/body" at=50,300 size=900x400${bodyFocused ? " [focused]" : ""}`;
  const s2 = "session-learner-turn-2";
  learner.observe(s2, "mobile_launch_app", { device, packageName: "com.example.notes" });
  learner.observe(s2, "mobile_list_elements_on_screen", { device }, { content: [{ type: "text", text: notesTree(false) }] });
  learner.observe(s2, "mobile_click_on_screen_at_coordinates", { device, x: 500, y: 500 });
  learner.observe(s2, "mobile_type_keys", { device, text: "Buy milk", submit: true });
  learner.observe(s2, "mobile_type_keys", { device, text: "ok" });
  learner.observe(s2, "mobile_click_on_screen_at_coordinates", { device, x: 990, y: 1990 });
  const notesRecipe = learner.synthesizeRecipe(s2, { name: "notes-learned" });

  assert.strictEqual(notesRecipe.steps[1].target_selector.label, "Note body", "Type must target the tapped field, not the stale focused one");
  assert.strictEqual(notesRecipe.steps[1].params.text, "{{input_text_1}}");
  assert.strictEqual(notesRecipe.steps[1].params.submit, true);
  assert.strictEqual(notesRecipe.steps[1].is_submission, true);
  assert.strictEqual(notesRecipe.steps[2].params.text, "ok", "Short text stays a literal");
  assert.deepStrictEqual(notesRecipe.steps[3].params, { x: 990, y: 1990 });
  assert.strictEqual(notesRecipe.steps[3].coordinate_fallback, true);
  console.log("  ✔ tapped field, short literals, submit flag and coordinate fallback learned correctly");

  // Step 8b: A workflow that crosses into a helper package is keyed on the app it started in
  const s3 = "session-learner-cross-package";
  learner.observe(s3, "mobile_launch_app", { device, packageName: "com.android.settings" });
  learner.observe(s3, "mobile_list_elements_on_screen", { device }, { content: [{ type: "text", text:
    `@e7 Button label="Search settings" at=886,159 size=122x122` }] });
  learner.observe(s3, "mobile_click_on_screen_at_coordinates", { device, x: 947, y: 220 });
  learner.observe(s3, "mobile_list_elements_on_screen", { device }, { content: [{ type: "text", text:
    `@e13 EditText id="com.google.android.settings.intelligence:id/open_search_view_edit_text" at=122,149 size=886x184 focused` }] });
  learner.observe(s3, "mobile_type_keys", { device, text: "battery" });
  const crossRecipe = learner.synthesizeRecipe(s3, { name: "settings-search-learned" });
  assert.strictEqual(crossRecipe.package_name, "com.android.settings");
  assert.strictEqual(crossRecipe.preconditions.package_foreground, "com.android.settings");
  console.log("  ✔ cross-package workflow keyed on the app it started in");

  // Step 9: Replaying a type step taps the target field and confirms focus before typing
  const RecipeRunner = require("../src/runner");
  const runner = new RecipeRunner(store);
  const makeInvoker = (focusOnTap) => {
    let bodyFocused = false;
    const calls = [];
    const invoker = async (name, args) => {
      calls.push(name);
      if (name === "mobile_list_elements_on_screen") return { content: [{ type: "text", text: notesTree(bodyFocused) }] };
      if (name === "mobile_click_on_screen_at_coordinates" && focusOnTap && args.y >= 300 && args.y <= 700) bodyFocused = true;
      return { content: [{ type: "text", text: "ok" }] };
    };
    return { invoker, calls };
  };
  const typeOnly = { ...notesRecipe, preconditions: undefined, steps: [notesRecipe.steps[1]] };

  const good = makeInvoker(true);
  const goodRun = await runner.run(good.invoker, typeOnly, { input_text_1: "Buy milk" }, device);
  assert.strictEqual(goodRun.success, true, JSON.stringify(goodRun));
  assert.ok(good.calls.indexOf("mobile_click_on_screen_at_coordinates") < good.calls.indexOf("mobile_type_keys"), "Must tap field before typing");

  const bad = makeInvoker(false);
  const badRun = await runner.run(bad.invoker, typeOnly, { input_text_1: "Buy milk" }, device);
  assert.strictEqual(badRun.success, false);
  assert.ok(!bad.calls.includes("mobile_type_keys"), "Must not type when focus cannot be confirmed");
  console.log("  ✔ type step focuses and verifies target field before typing, and refuses otherwise");

  // Clean up
  fs.rmSync(testStoreDir, { recursive: true, force: true });
  console.log("✔ Suite 7: Automated recipe learning pipeline passed all checks\n");
}

module.exports = { runAutomatedLearningTests };

if (require.main === module) {
  runAutomatedLearningTests().catch(err => {
    console.error("Suite 7 failed:", err);
    process.exit(1);
  });
}
