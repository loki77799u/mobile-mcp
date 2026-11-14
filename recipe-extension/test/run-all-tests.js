"use strict";

// Point the store (and the shared audit logger) at a throwaway dir before any src module loads,
// so test runs never write to the real ~/.mobile-mcp/recipes/audit.log.
const os = require("node:os");
const path = require("node:path");
process.env.MOBILE_MCP_RECIPES_DIR = path.join(os.tmpdir(), "mobile-mcp-recipes-test-" + Date.now());

const { runProxyCompatibilityTests } = require("./test-proxy");
const { runGuidanceDeliveryTests } = require("./test-guidance-delivery");
const { runTextInsertionTests } = require("./test-text-insertion");
const { runRecipeRunnerTests } = require("./test-recipe-runner");
const { runSafetySanitizationTests } = require("./test-safety-sanitization");
const { runMeasurementTests } = require("./test-measurements");
const { runAutomatedLearningTests } = require("./test-automated-learning");

async function main() {
  console.log("================================================================================");
  console.log("  MOBILE MCP RECIPE EXTENSION — AUTOMATED TEST HARNESS & VALIDATION");
  console.log("================================================================================\n");

  const start = Date.now();
  let failed = 0;

  try {
    await runProxyCompatibilityTests();
  } catch (err) {
    console.error("❌ Suite 1 (Proxy Compatibility) failed:", err);
    failed++;
  }

  try {
    await runGuidanceDeliveryTests();
  } catch (err) {
    console.error("❌ Suite 2 (Guidance Delivery & Deduplication) failed:", err);
    failed++;
  }

  try {
    await runTextInsertionTests();
  } catch (err) {
    console.error("❌ Suite 3 (Exact Text Insertion) failed:", err);
    failed++;
  }

  try {
    await runRecipeRunnerTests();
  } catch (err) {
    console.error("❌ Suite 4 (Recipe Runner & Verification) failed:", err);
    failed++;
  }

  try {
    await runSafetySanitizationTests();
  } catch (err) {
    console.error("❌ Suite 5 (Safety & Sanitization) failed:", err);
    failed++;
  }

  try {
    await runMeasurementTests();
  } catch (err) {
    console.error("❌ Suite 6 (Measurements) failed:", err);
    failed++;
  }

  try {
    await runAutomatedLearningTests();
  } catch (err) {
    console.error("❌ Suite 7 (Automated Recipe Learning) failed:", err);
    failed++;
  }

  const duration = ((Date.now() - start) / 1000).toFixed(2);
  console.log("================================================================================");
  if (failed === 0) {
    console.log(`✅ ALL TEST SUITES PASSED (${duration}s)`);
    console.log("================================================================================");
    process.exit(0);
  } else {
    console.error(`❌ ${failed} TEST SUITE(S) FAILED (${duration}s)`);
    console.log("================================================================================");
    process.exit(1);
  }
}

main();
