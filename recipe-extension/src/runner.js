"use strict";

const { findElement, parseAccessibilityTree } = require("./matcher");
const { insertTextVerified } = require("./helpers/text-insertion");
const { ensureThinkingState } = require("./helpers/chatgpt");
const { compareExactText } = require("./utils");
const config = require("./config");
const audit = require("./audit");

class RecipeRunner {
  constructor(store) {
    this.store = store;
  }

  /**
   * Replaces {{param}} placeholders in string or object values.
   */
  substituteParams(template, values = {}) {
    if (typeof template === "string") {
      let result = template;
      for (const [k, v] of Object.entries(values)) {
        const strVal = typeof v === "object" ? JSON.stringify(v) : String(v);
        result = result.split(`{{${k}}}`).join(strVal);
      }
      return result;
    }
    if (Array.isArray(template)) {
      return template.map(item => this.substituteParams(item, values));
    }
    if (template && typeof template === "object") {
      const out = {};
      for (const [k, v] of Object.entries(template)) {
        out[k] = this.substituteParams(v, values);
      }
      return out;
    }
    return template;
  }

  /**
   * Executes a recipe step by step with verification and diagnostics.
   *
   * @param {Function} invokeTool - Tool dispatcher (toolName, args) => Promise<any>
   * @param {object} recipe - Full recipe object
   * @param {object} params - Input parameters
   * @param {string} device - Device ID
   * @returns {Promise<object>}
   */
  async run(invokeTool, recipe, params = {}, device) {
    const startTime = Date.now();
    const recipeName = recipe.name;
    const globalFailurePolicy = recipe.on_failure || "stop";

    if (!device) {
      return {
        success: false,
        recipe: recipeName,
        error: "Missing required 'device' parameter"
      };
    }

    audit.log("recipe_run_started", {
      recipe: recipeName,
      package: recipe.package_name || recipe.app,
      device
    });

    // 1. Validate required parameters
    if (recipe.params) {
      for (const [pName, pDef] of Object.entries(recipe.params)) {
        if (pDef.required && (params[pName] === undefined || params[pName] === null || params[pName] === "")) {
          return {
            success: false,
            recipe: recipeName,
            error: `Missing required parameter '${pName}': ${pDef.description || ""}`
          };
        }
      }
    }

    // 2. Preconditions Check
    if (recipe.preconditions) {
      const precheck = await this._checkPreconditions(invokeTool, recipe.preconditions, device, recipe.package_name || recipe.app);
      if (!precheck.success) {
        return {
          success: false,
          recipe: recipeName,
          error: `Precondition failed: ${precheck.error}`,
          precondition_details: precheck
        };
      }
    }

    // 3. Execute Steps
    const stepResults = [];
    let isAmbiguousSubmission = false;

    for (const step of recipe.steps) {
      const stepStart = Date.now();
      const stepId = step.id;
      const resolvedParams = this.substituteParams(step.params || {}, params);
      const resolvedSelector = step.target_selector ? this.substituteParams(step.target_selector, params) : null;
      const isSubmissionStep = step.is_submission === true || 
                               (step.note && /\b(send|submit|purchase|confirm)\b/i.test(step.note));

      let stepResult = null;
      try {
        stepResult = await this._executeStep(invokeTool, step.action, resolvedParams, resolvedSelector, device);
      } catch (err) {
        stepResult = { success: false, error: err.message };
      }

      const durationMs = Date.now() - stepStart;
      stepResults.push({
        step_id: stepId,
        action: step.action,
        note: step.note,
        success: stepResult.success,
        duration_ms: durationMs,
        error: stepResult.error,
        details: stepResult.details
      });

      if (!stepResult.success) {
        // If this was an uncertain submission step, flag ambiguous submission and NEVER auto-retry
        if (isSubmissionStep) {
          isAmbiguousSubmission = true;
          audit.log("ambiguous_submission_detected", {
            recipe: recipeName,
            step_id: stepId,
            error: stepResult.error
          });
          return {
            success: false,
            recipe: recipeName,
            ambiguous_submission: true,
            failed_step: stepId,
            error: `Uncertain submission outcome at step ${stepId} (${step.note || step.action}): ${stepResult.error}. Automatic retry is strictly prohibited to prevent duplicate actions.`,
            step_results: stepResults,
            duration_ms: Date.now() - startTime
          };
        }

        const failurePolicy = step.on_failure || globalFailurePolicy;
        if (failurePolicy === "skip") {
          continue;
        }

        return {
          success: false,
          recipe: recipeName,
          failed_step: stepId,
          error: `Recipe failed at step ${stepId} (${step.note || step.action}): ${stepResult.error}`,
          steps_completed: stepResults.filter(r => r.success).length,
          total_steps: recipe.steps.length,
          step_results: stepResults,
          duration_ms: Date.now() - startTime
        };
      }

      // Step wait_after check
      if (step.wait_after) {
        const resolvedWait = this.substituteParams(step.wait_after, params);
        const waitResult = await this._handleWait(invokeTool, resolvedWait, device);
        if (!waitResult.success) {
          if (isSubmissionStep) {
            return {
              success: false,
              recipe: recipeName,
              ambiguous_submission: true,
              failed_step: stepId,
              error: `Submission step executed, but completion verification timed out: ${waitResult.error}. Manual verification required before re-attempting.`,
              step_results: stepResults,
              duration_ms: Date.now() - startTime
            };
          }
          return {
            success: false,
            recipe: recipeName,
            failed_step: stepId,
            error: `Step ${stepId} wait_after condition failed: ${waitResult.error}`,
            step_results: stepResults,
            duration_ms: Date.now() - startTime
          };
        }
      }
    }

    // 4. Postconditions Check
    if (recipe.postconditions) {
      const postcheck = await this._checkPostconditions(invokeTool, recipe.postconditions, params, device);
      if (!postcheck.success) {
        return {
          success: false,
          recipe: recipeName,
          error: `Postcondition verification failed: ${postcheck.error}`,
          step_results: stepResults,
          duration_ms: Date.now() - startTime
        };
      }
    }

    const totalDuration = Date.now() - startTime;
    audit.log("recipe_run_succeeded", {
      recipe: recipeName,
      duration_ms: totalDuration
    });

    return {
      success: true,
      recipe: recipeName,
      steps_completed: stepResults.length,
      total_steps: recipe.steps.length,
      duration_ms: totalDuration,
      step_results: stepResults
    };
  }

  async _checkPreconditions(invokeTool, preconditions, device, expectedPackage) {
    if (preconditions.package_foreground && expectedPackage) {
      try {
        const fgRes = await invokeTool("mobile_get_foreground_app", { device });
        const text = JSON.stringify(fgRes);
        if (!text.includes(expectedPackage)) {
          return {
            success: false,
            error: `App '${expectedPackage}' is not in foreground.`
          };
        }
      } catch (err) {
        return { success: false, error: `Foreground check error: ${err.message}` };
      }
    }

    if (preconditions.element_exists) {
      const treeRes = await invokeTool("mobile_list_elements_on_screen", { device, format: "text" });
      const rawTree = (treeRes && treeRes.content && treeRes.content[0]?.text) || treeRes;
      const match = findElement(rawTree, preconditions.element_exists);
      if (!match.found) {
        return {
          success: false,
          error: `Required element missing: ${JSON.stringify(preconditions.element_exists)}`
        };
      }
    }

    return { success: true };
  }

  async _executeStep(invokeTool, action, params, selector, device) {
    switch (action) {
      case "click": {
        // Learned steps with no identifiable element carry raw coordinates instead of a selector
        if (!selector && typeof params.x === "number" && typeof params.y === "number") {
          const coordRes = await invokeTool("mobile_click_on_screen_at_coordinates", { device, x: params.x, y: params.y });
          if (coordRes && (coordRes.isError || coordRes.error)) {
            return { success: false, error: coordRes.error || (coordRes.content && coordRes.content[0]?.text) || "Click failed" };
          }
          return { success: true, details: { click: { x: params.x, y: params.y }, coordinate_fallback: true, result: coordRes } };
        }
        // Find element on fresh tree
        const treeRes = await invokeTool("mobile_list_elements_on_screen", { device, format: "text" });
        const rawTree = (treeRes && treeRes.content && treeRes.content[0]?.text) || treeRes;
        const match = findElement(rawTree, selector || params);
        if (!match.found) {
          return { success: false, error: match.error || "Element not found" };
        }
        if (match.ambiguous) {
          return { success: false, error: match.error };
        }
        const coords = match.element.center;
        const clickRes = await invokeTool("mobile_click_on_screen_at_coordinates", {
          device,
          x: coords.x,
          y: coords.y
        });
        if (clickRes && (clickRes.isError || clickRes.error)) {
          const errText = clickRes.error || (clickRes.content && clickRes.content[0]?.text) || "Click failed";
          return { success: false, error: errText };
        }
        return { success: true, details: { click: coords, result: clickRes } };
      }

      case "helper_insert_text": {
        const textToInsert = params.text;
        const insertRes = await insertTextVerified(invokeTool, {
          device,
          text: textToInsert,
          target_selector: selector || params.target_selector
        });
        return insertRes;
      }

      case "type": {
        const text = params.text;
        if (selector) {
          const focus = await this._ensureFocused(invokeTool, selector, device);
          if (!focus.success) return focus;
        }
        const typeRes = await invokeTool("mobile_type_keys", {
          device,
          text,
          submit: params.submit === true
        });
        if (typeRes && (typeRes.isError || typeRes.error)) {
          return { success: false, error: typeRes.error || (typeRes.content && typeRes.content[0]?.text) || "Type failed" };
        }
        return { success: true, details: typeRes };
      }

      case "press": {
        const button = params.button || params.key;
        const pressRes = await invokeTool("mobile_press_button", {
          device,
          button
        });
        if (pressRes && (pressRes.isError || pressRes.error)) {
          return { success: false, error: pressRes.error || (pressRes.content && pressRes.content[0]?.text) || "Press button failed" };
        }
        return { success: true, details: pressRes };
      }

      case "swipe": {
        const swipeRes = await invokeTool("mobile_swipe_on_screen", {
          device,
          direction: params.direction || "up",
          distance: params.distance ? parseInt(params.distance, 10) : undefined
        });
        if (swipeRes && (swipeRes.isError || swipeRes.error)) {
          return { success: false, error: swipeRes.error || (swipeRes.content && swipeRes.content[0]?.text) || "Swipe failed" };
        }
        return { success: true, details: swipeRes };
      }

      case "helper_thinking_state": {
        const stateRes = await ensureThinkingState(invokeTool, {
          device,
          desiredState: params.desired_state || "on"
        });
        return stateRes;
      }

      case "wait": {
        const waitRes = await this._handleWait(invokeTool, params, device);
        return waitRes;
      }

      default:
        return { success: false, error: `Unsupported recipe action '${action}'` };
    }
  }

  /**
   * Makes sure the field matching `selector` holds focus before typing into it:
   * taps it if needed, then re-reads the screen and checks it reports [focused].
   */
  async _ensureFocused(invokeTool, selector, device) {
    const readTree = async () => {
      const res = await invokeTool("mobile_list_elements_on_screen", { device, format: "text" });
      return (res && res.content && res.content[0]?.text) || res;
    };

    let match = findElement(await readTree(), selector);
    if (!match.found) return { success: false, error: `Target field not found: ${match.error || JSON.stringify(selector)}` };
    if (match.ambiguous) return { success: false, error: `Ambiguous target field: ${match.error}` };
    if (match.element.focused) return { success: true };

    const { center } = match.element;
    await invokeTool("mobile_click_on_screen_at_coordinates", { device, x: center.x, y: center.y });
    await new Promise(r => setTimeout(r, 400));

    match = findElement(await readTree(), selector);
    if (!match.found || match.ambiguous || !match.element.focused) {
      return { success: false, error: "Focus verification failed: target field did not report [focused] after tap. Not typing, to avoid text landing in the wrong field." };
    }
    return { success: true };
  }

  async _handleWait(invokeTool, waitCondition, device) {
    const condition = waitCondition.condition;
    const timeoutMs = Math.min(
      parseInt(waitCondition.timeout_ms || waitCondition.timeout || "5000", 10),
      config.DEFAULTS.MAX_STEP_TIMEOUT_MS
    );
    const intervalMs = config.DEFAULTS.POLL_INTERVAL_MS;
    const start = Date.now();

    if (condition === "delay") {
      const ms = waitCondition.timeout_ms ? parseInt(waitCondition.timeout_ms, 10) : 1000;
      await new Promise(r => setTimeout(r, ms));
      return { success: true };
    }

    while (Date.now() - start < timeoutMs) {
      const treeRes = await invokeTool("mobile_list_elements_on_screen", { device, format: "text" });
      const rawTree = (treeRes && treeRes.content && treeRes.content[0]?.text) || treeRes;

      if (condition === "element_exists") {
        const match = findElement(rawTree, waitCondition.selector || { text_contains: waitCondition.value });
        if (match.found) {
          return { success: true };
        }
      } else if (condition === "element_gone") {
        const match = findElement(rawTree, waitCondition.selector || { text_contains: waitCondition.value });
        if (!match.found) {
          return { success: true };
        }
      } else if (condition === "element_text_matches") {
        const match = findElement(rawTree, waitCondition.selector || { role: "EditText" });
        if (match.found) {
          const actualText = match.element.text || match.element.value || "";
          const cmp = compareExactText(waitCondition.value, actualText);
          if (cmp.match) {
            return { success: true };
          }
        }
      }

      await new Promise(r => setTimeout(r, intervalMs));
    }

    return {
      success: false,
      error: `Wait condition '${condition}' timed out after ${timeoutMs}ms (target: ${JSON.stringify(waitCondition.value || waitCondition.selector)})`
    };
  }

  async _checkPostconditions(invokeTool, postconditions, params, device) {
    const treeRes = await invokeTool("mobile_list_elements_on_screen", { device, format: "text" });
    const rawTree = (treeRes && treeRes.content && treeRes.content[0]?.text) || treeRes;

    if (postconditions.element_exists) {
      const selector = this.substituteParams(postconditions.element_exists, params);
      const match = findElement(rawTree, selector);
      if (!match.found) {
        return { success: false, error: `Postcondition failed: element ${JSON.stringify(selector)} not found` };
      }
    }

    return { success: true };
  }
}

module.exports = RecipeRunner;
