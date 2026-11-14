"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const path = require("node:path");
const { validateRecipe, validateGuidance } = require("../src/types");
const { sanitizeForLogging } = require("../src/utils");
const RecipeStore = require("../src/store");

async function runSafetySanitizationTests() {
  console.log("▶ Running Test Suite: Schema Validation & Sensitive Data Sanitization");

  const testStoreDir = path.join("/tmp", "test-safety-" + Date.now());
  const store = new RecipeStore(testStoreDir);

  // Test 1: Rejection of malformed schema version
  const badVersion = {
    schema_version: 1, // Must be 2
    name: "bad-version",
    description: "test",
    package_name: "com.test",
    steps: [{ id: 1, action: "click" }]
  };
  const vRes1 = validateRecipe(badVersion);
  assert.strictEqual(vRes1.valid, false);
  assert.ok(vRes1.errors.some(e => e.includes("schema_version")));
  console.log("  ✔ invalid schema version rejected");

  // Test 2: Rejection of arbitrary shell/code execution attempts
  const maliciousRecipe = {
    schema_version: 2,
    name: "malicious-cmd",
    description: "Tries to execute shell",
    package_name: "com.test",
    steps: [
      {
        id: 1,
        action: "exec_shell", // Forbidden action
        params: { command: "rm -rf /" }
      }
    ]
  };
  const vRes2 = validateRecipe(maliciousRecipe);
  assert.strictEqual(vRes2.valid, false);
  assert.ok(vRes2.errors.some(e => e.includes("exec_shell")));

  const maliciousParamRecipe = {
    schema_version: 2,
    name: "malicious-param",
    description: "Tries to pass shell param",
    package_name: "com.test",
    steps: [
      {
        id: 1,
        action: "click",
        params: { exec: "bash -c 'whoami'" }
      }
    ]
  };
  const vRes3 = validateRecipe(maliciousParamRecipe);
  assert.strictEqual(vRes3.valid, false);
  assert.ok(vRes3.errors.some(e => e.includes("forbidden execution parameter 'exec'")));
  console.log("  ✔ arbitrary shell/code execution vectors strictly rejected by schema validator");

  // Test 3: Newly saved recipes default to 'draft' status unless explicitly marked
  const draftRecipe = {
    schema_version: 2,
    name: "learned-workflow",
    description: "Newly synthesized workflow",
    package_name: "com.openai.chatgpt",
    steps: [
      { id: 1, action: "click", target_selector: { role: "Button" } }
    ]
  };
  const saveRes = store.saveRecipe(draftRecipe, { sessionId: "sess-abc" });
  assert.strictEqual(saveRes.status, "draft", "Must default to draft status");
  const loaded = store.getRecipe("learned-workflow");
  assert.strictEqual(loaded.validation_status, "draft");
  console.log("  ✔ newly learned recipes default to 'draft' validation status");

  // Test 4: Explicit recipe deletion
  const deleted = store.deleteRecipe("learned-workflow");
  assert.strictEqual(deleted, true);
  assert.strictEqual(store.getRecipe("learned-workflow"), null);
  const deleteNonexistent = store.deleteRecipe("learned-workflow");
  assert.strictEqual(deleteNonexistent, false);
  console.log("  ✔ explicit recipe deletion verified");

  // Test 5: Sensitive Data & Secret Sanitization
  const sensitiveObj = {
    authToken: "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.secretpayload",
    password: "UserSecretPassword123!",
    api_key: "sk-1234567890abcdef1234567890",
    safeField: "Stand-In prompt"
  };
  const sanitized = sanitizeForLogging(sensitiveObj);
  assert.strictEqual(sanitized.authToken, "[REDACTED]");
  assert.strictEqual(sanitized.password, "[REDACTED]");
  assert.strictEqual(sanitized.api_key, "[REDACTED]");
  assert.strictEqual(sanitized.safeField, "Stand-In prompt");
  console.log("  ✔ sensitive tokens and credentials scrubbed from logging");

  // Clean up
  fs.rmSync(testStoreDir, { recursive: true, force: true });
  console.log("✔ Suite 5: Safety and sanitization verified successfully\n");
}

module.exports = { runSafetySanitizationTests };

if (require.main === module) {
  runSafetySanitizationTests().catch(err => {
    console.error("Suite 5 failed:", err);
    process.exit(1);
  });
}
