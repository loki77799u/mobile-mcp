"use strict";

const { findElement, parseAccessibilityTree } = require("../matcher");
const audit = require("../audit");

/**
 * Checks and ensures the desired Thinking Mode state in ChatGPT Android.
 * Note: In ChatGPT Android (Free plan), Think harder auto-resets after each response.
 *
 * @param {Function} invokeTool
 * @param {object} options
 * @param {string} options.device
 * @param {"on"|"off"} options.desiredState
 * @returns {Promise<object>}
 */
async function ensureThinkingState(invokeTool, options = {}) {
  const { device, desiredState = "on" } = options;
  if (!device) return { success: false, error: "Missing device" };

  audit.log("chatgpt_check_thinking", { device, desiredState });

  // Get current screen
  const treeRes = await invokeTool("mobile_list_elements_on_screen", { device, format: "text" });
  const rawTree = (treeRes && treeRes.content && treeRes.content[0]?.text) || treeRes;
  const elements = parseAccessibilityTree(rawTree);

  // Check if Think indicator is present in composer
  const hasThinkIndicator = elements.some(el => {
    const text = (el.text || el.label || "").toLowerCase();
    return text.includes("think harder") || text.includes("thinking") || text === "think";
  });

  const currentState = hasThinkIndicator ? "on" : "off";
  if (currentState === desiredState) {
    return {
      success: true,
      state: currentState,
      verified: true,
      note: `Thinking state is already ${desiredState} before send.`
    };
  }

  // Need to toggle: Tap Attachment (+) button
  const attachmentMatch = findElement(elements, { label: "Attachment" });
  if (!attachmentMatch.found) {
    return {
      success: false,
      error: "Could not find Attachment (+) button to toggle Think harder mode"
    };
  }

  const attachCenter = attachmentMatch.element.center;
  await invokeTool("mobile_click_on_screen_at_coordinates", {
    device,
    x: attachCenter.x,
    y: attachCenter.y
  });

  await new Promise(r => setTimeout(r, 600));

  // Find "Think harder" in the opened attachment menu
  const menuTreeRes = await invokeTool("mobile_list_elements_on_screen", { device, format: "text" });
  const menuTree = (menuTreeRes && menuTreeRes.content && menuTreeRes.content[0]?.text) || menuTreeRes;
  const menuElements = parseAccessibilityTree(menuTree);

  const thinkOptionMatch = findElement(menuElements, { label_contains: "Think" });
  const thinkFallback = thinkOptionMatch.found ? thinkOptionMatch : findElement(menuElements, { text_contains: "Think" });

  if (!thinkFallback.found) {
    // Dismiss attachment menu to avoid leaving UI stuck
    await invokeTool("mobile_press_button", { device, button: "BACK" });
    return {
      success: false,
      error: "Could not find 'Think harder' option in attachment menu"
    };
  }

  const thinkCenter = thinkFallback.element.center;
  await invokeTool("mobile_click_on_screen_at_coordinates", {
    device,
    x: thinkCenter.x,
    y: thinkCenter.y
  });

  await new Promise(r => setTimeout(r, 600));

  // Verify resulting state
  const verifyTreeRes = await invokeTool("mobile_list_elements_on_screen", { device, format: "text" });
  const verifyTree = (verifyTreeRes && verifyTreeRes.content && verifyTreeRes.content[0]?.text) || verifyTreeRes;
  const verifyElements = parseAccessibilityTree(verifyTree);

  const nowHasIndicator = verifyElements.some(el => {
    const text = (el.text || el.label || "").toLowerCase();
    return text.includes("think harder") || text.includes("thinking") || text === "think";
  });
  const newState = nowHasIndicator ? "on" : "off";

  if (newState !== desiredState) {
    return {
      success: false,
      error: `Failed to switch thinking state to ${desiredState}. Current state remains ${newState}.`
    };
  }

  return {
    success: true,
    state: newState,
    verified: true,
    note: `Thinking state successfully verified as ${newState}. Note: Will auto-reset after response on Free plan.`
  };
}

/**
 * Separates ChatGPT response UI into internal tool/working activity and final answer text.
 * @param {string|Array<object>} rawTree
 * @returns {object}
 */
function parseChatGPTResponse(rawTree) {
  const elements = parseAccessibilityTree(rawTree);

  const workingSections = [];
  const finalAnswerLines = [];
  let isWorkingBlock = false;

  const ignoreLabels = new Set([
    "Navigate up",
    "Edit Menu",
    "Reply to ChatGPT",
    "Attachment",
    "Dictation",
    "Start a voice conversation",
    "Copy",
    "Good response",
    "Bad response",
    "Read aloud",
    "Share",
    "More actions"
  ]);

  for (const el of elements) {
    const text = (el.text || "").trim();
    const label = (el.label || "").trim();

    if (ignoreLabels.has(label) || ignoreLabels.has(text)) continue;

    // Detect "Worked for Xs" or internal tool search headers
    if (/^Worked for \d+s/i.test(text)) {
      isWorkingBlock = true;
      workingSections.push(text);
      continue;
    }

    if (isWorkingBlock) {
      if (
        text.includes("Searching") ||
        text.includes("Scored") ||
        text.includes("Identified") ||
        text.includes("Prepared") ||
        text.includes("Read mounted")
      ) {
        workingSections.push(text);
        continue;
      }
      // If we hit standard text like uppercase title or scorecard or user bubble, working block ended
      isWorkingBlock = false;
    }

    if (text && !text.startsWith("One element per line:")) {
      finalAnswerLines.push(text);
    }
  }

  return {
    working_sections: workingSections,
    final_answer_lines: finalAnswerLines,
    final_answer_text: finalAnswerLines.join("\n"),
    has_thinking_ui: workingSections.length > 0
  };
}

/**
 * Identifies account subscription plan from UI cues.
 * Note: ChatGPT Android does not explicitly display the literal word "Free" or "Plus" as the plan label.
 */
function detectSubscriptionPlan(rawTree) {
  const elements = parseAccessibilityTree(rawTree);
  const allTexts = elements.map(e => (e.text || "") + " " + (e.label || "")).join(" ");

  if (allTexts.includes("Get Plus") || allTexts.includes("Upgrade plan")) {
    return {
      plan_inferred: "Free",
      explicit_label: false,
      confidence: "qualified",
      note: "Plan inferred from 'Get Plus'/'Upgrade plan' prompts; no explicit 'Free' badge exists in this app version."
    };
  }

  return {
    plan_inferred: "Unknown",
    explicit_label: false,
    confidence: "low",
    note: "Neither 'Get Plus' nor plan indicators identified."
  };
}

module.exports = {
  ensureThinkingState,
  parseChatGPTResponse,
  detectSubscriptionPlan
};
