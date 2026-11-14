"use strict";

const { findElement } = require("../matcher");
const { compareExactText } = require("../utils");
const audit = require("../audit");

/**
 * Executes verified exact text insertion on Android/iOS via Mobile MCP tools.
 * 
 * Guarantees:
 * 1. Checks focus on the actual editable node (not the tree header).
 * 2. Clicks to focus if not already focused, verifying focus transition.
 * 3. Uses exact clipboard paste to prevent mobile_type_keys spacing bugs (e.g. "v1.2" -> "v1. 2").
 * 4. Reads back the screen tree and performs strict character-for-character comparison.
 * 5. Fails fast with precise divergence location if readback does not match.
 *
 * @param {Function} invokeTool - Function (toolName, args) => Promise<any>
 * @param {object} options
 * @param {string} options.device - Device ID
 * @param {string} options.text - Exact text to insert
 * @param {object} [options.target_selector] - Optional semantic selector for the target field
 * @param {boolean} [options.clear_first=false] - Whether to clear field before inserting
 * @returns {Promise<object>} Result with verification details
 */
async function insertTextVerified(invokeTool, options = {}) {
  const { device, text, target_selector, clear_first = false } = options;

  if (!device) {
    return { success: false, error: "Missing required 'device' parameter" };
  }
  if (typeof text !== "string") {
    return { success: false, error: "Missing required 'text' parameter (must be string)" };
  }

  audit.log("insert_text_started", { device, text_len: text.length });

  // 1. Get current screen state
  const initialTreeRes = await invokeTool("mobile_list_elements_on_screen", { device, format: "text" });
  const rawTree = (initialTreeRes && initialTreeRes.content && initialTreeRes.content[0]?.text) || initialTreeRes;

  // 2. Locate editable element
  let selector = target_selector;
  if (!selector) {
    selector = { role: "EditText" };
  }

  let matchResult = findElement(rawTree, selector);
  if (!matchResult.found) {
    // Try generic editable fallback
    matchResult = findElement(rawTree, { editable: true });
  }

  if (!matchResult.found) {
    return {
      success: false,
      error: `Could not locate editable element: ${matchResult.error || "No editable field found"}`
    };
  }
  if (matchResult.ambiguous) {
    return {
      success: false,
      error: `Ambiguous target for text insertion: ${matchResult.error}`
    };
  }

  let targetElement = matchResult.element;

  // 3. Focus Check & Acquisition (from actual node, ignoring tree header text)
  if (!targetElement.focused) {
    // Click center of target element to gain focus
    const clickCoords = targetElement.center || {
      x: targetElement.coordinates.x + Math.round(targetElement.coordinates.width / 2),
      y: targetElement.coordinates.y + Math.round(targetElement.coordinates.height / 2)
    };

    await invokeTool("mobile_click_on_screen_at_coordinates", {
      device,
      x: clickCoords.x,
      y: clickCoords.y
    });

    // Short wait for focus animation and re-query
    await new Promise(r => setTimeout(r, 400));

    const postClickTreeRes = await invokeTool("mobile_list_elements_on_screen", { device, format: "text" });
    const postClickTree = (postClickTreeRes && postClickTreeRes.content && postClickTreeRes.content[0]?.text) || postClickTreeRes;

    const recheckMatch = findElement(postClickTree, selector);
    if (!recheckMatch.found) {
      return {
        success: false,
        error: "Target editable element disappeared after focus click attempt"
      };
    }

    targetElement = recheckMatch.element;
    if (!targetElement.focused) {
      return {
        success: false,
        error: "Focus verification failed: target node did not report [focused] after click. Aborting paste to prevent lost input."
      };
    }
  }

  // 4. Set clipboard content
  await invokeTool("mobile_clipboard", {
    device,
    text
  });

  // 5. Send PASTE button / keyevent
  // On Android, pressing button "PASTE" or triggering keyevent 279 executes clipboard paste
  await invokeTool("mobile_press_button", {
    device,
    button: "PASTE"
  });

  // Allow UI time to commit text into the input buffer
  await new Promise(r => setTimeout(r, 500));

  // 6. Read back screen tree and verify
  const readbackTreeRes = await invokeTool("mobile_list_elements_on_screen", { device, format: "text" });
  const readbackTree = (readbackTreeRes && readbackTreeRes.content && readbackTreeRes.content[0]?.text) || readbackTreeRes;

  const readbackMatch = findElement(readbackTree, selector);
  if (!readbackMatch.found) {
    return {
      success: false,
      error: "Could not find target element during post-insertion readback check"
    };
  }

  const updatedElement = readbackMatch.element;
  const actualText = updatedElement.text !== undefined ? updatedElement.text : (updatedElement.value || "");

  // 7. Strict comparison (handles Unicode NFC, newlines, exact content)
  const comparison = compareExactText(text, actualText);

  if (!comparison.match) {
    audit.log("insert_text_mismatch", {
      device,
      expected_len: comparison.expectedLen,
      actual_len: comparison.actualLen,
      diff: comparison.diffHint
    });

    return {
      success: false,
      verified: false,
      exact_match: false,
      error: `Text verification mismatch: inserted text does not match field readback. ${comparison.diffHint}`,
      expected_length: comparison.expectedLen,
      actual_length: comparison.actualLen,
      diff_hint: comparison.diffHint
    };
  }

  audit.log("insert_text_verified", {
    device,
    text_len: comparison.expectedLen
  });

  return {
    success: true,
    verified: true,
    exact_match: true,
    length: comparison.expectedLen,
    ref: updatedElement.ref,
    coordinates: updatedElement.coordinates,
    note: "Text inserted via clipboard paste and verified character-for-character against field readback."
  };
}

module.exports = {
  insertTextVerified
};
