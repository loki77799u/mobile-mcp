"use strict";

const crypto = require("node:crypto");
const { findElement, parseAccessibilityTree } = require("./matcher");
const { sanitizeForLogging } = require("./utils");
const audit = require("./audit");

class AutomatedRecipeLearner {
  constructor(store) {
    this.store = store;
    // Map of sessionId -> session tracking buffer
    this.sessions = new Map();
  }

  /**
   * Gets or initializes the tracking session.
   */
  _getSession(sessionId) {
    const sId = sessionId || "default-session";
    if (!this.sessions.has(sId)) {
      this.sessions.set(sId, {
        activePackage: null,
        deviceId: null,
        lastElements: [],
        lastClickedElement: null,
        rawTreeText: "",
        actions: [],
        lastActionTimestamp: Date.now()
      });
    }
    return this.sessions.get(sId);
  }

  /**
   * Observes a tool call and its result passing through the proxy.
   * Correlates actions with recent accessibility tree elements to produce semantic selectors.
   *
   * @param {string} sessionId
   * @param {string} toolName
   * @param {object} args
   * @param {object} result
   */
  observe(sessionId, toolName, args = {}, result = null) {
    const session = this._getSession(sessionId);
    session.lastActionTimestamp = Date.now();
    if (args.device) session.deviceId = args.device;

    // 1. Observe tree dumps
    if (toolName === "mobile_list_elements_on_screen" && result) {
      const text = (result.content && result.content[0]?.text) || (typeof result === "string" ? result : "");
      session.rawTreeText = text;
      session.lastElements = parseAccessibilityTree(text);

      // Detect package signature from element resource-ids
      const pkgMatch = text.match(/([a-zA-Z0-9_\.]+):id\//);
      if (pkgMatch && !pkgMatch[1].startsWith("android")) {
        session.activePackage = pkgMatch[1];
      }
      return;
    }

    // 2. Observe app launches or foreground changes
    if (toolName === "mobile_launch_app" && args.packageName) {
      session.activePackage = args.packageName;
      return;
    }
    if (toolName === "mobile_get_foreground_app" && result) {
      const text = JSON.stringify(result);
      const m = text.match(/"package":\s*"([^"]+)"/) || text.match(/\b(com\.[a-zA-Z0-9_\.]+)\b/);
      if (m) session.activePackage = m[1];
      return;
    }

    // 3. Observe user actions and correlate with accessibility tree
    if (toolName === "mobile_click_on_screen_at_coordinates" && args.x !== undefined && args.y !== undefined) {
      const element = this._findElementAtCoordinates(session.lastElements, args.x, args.y);
      const selector = this._selectorFromElement(element);
      session.lastClickedElement = element;
      session.actions.push({
        package: session.activePackage,
        action: "click",
        x: args.x,
        y: args.y,
        target_selector: selector,
        note: selector ? `Click ${selector.label || selector.text || selector.role || "element"}` : `Click at ${args.x},${args.y} (no label found; coordinate fallback)`
      });
      return;
    }

    if (toolName === "mobile_type_keys" && args.text) {
      // The tree we hold was read before the tap that focused the field, so prefer the field
      // that was just tapped over whatever the stale tree marks as focused.
      const lastAction = session.actions[session.actions.length - 1];
      const tapped = lastAction && lastAction.action === "click" ? session.lastClickedElement : null;
      const focusedSelector = this._isEditable(tapped)
        ? { ...this._selectorFromElement(tapped), editable: true }
        : this._findCurrentlyFocusedSelector(session.lastElements);
      session.actions.push({
        package: session.activePackage,
        action: "type",
        text: args.text,
        target_selector: focusedSelector,
        submit: args.submit === true,
        note: `Type text into ${focusedSelector ? (focusedSelector.label || focusedSelector.role) : "focused field"}`
      });
      return;
    }

    if (toolName === "mobile_helper_insert_text" && args.text) {
      session.actions.push({
        package: session.activePackage,
        action: "helper_insert_text",
        text: args.text,
        target_selector: args.target_selector || { role: "EditText", editable: true },
        note: "Verified text insertion via clipboard paste"
      });
      return;
    }

    if (toolName === "mobile_helper_thinking_state") {
      session.actions.push({
        package: session.activePackage,
        action: "helper_thinking_state",
        desired_state: args.desired_state || "on",
        note: `Verify thinking mode is ${args.desired_state || "on"}`
      });
      return;
    }

    if (toolName === "mobile_press_button" && args.button) {
      session.actions.push({
        package: session.activePackage,
        action: "press",
        button: args.button,
        note: `Press button ${args.button}`
      });
      return;
    }
  }

  _isEditable(el) {
    return Boolean(el && ((el.type && /EditText|TextField|SearchField/.test(el.type)) || el.editable === true));
  }

  /**
   * Finds the smallest element whose bounds contain the screen coordinates.
   */
  _findElementAtCoordinates(elements, x, y) {
    if (!Array.isArray(elements) || elements.length === 0) return null;

    // Find the smallest bounding box containing (x, y)
    let best = null;
    let minArea = Infinity;

    for (const el of elements) {
      const coords = el.coordinates;
      if (!coords) continue;
      if (x >= coords.x && x <= coords.x + coords.width &&
          y >= coords.y && y <= coords.y + coords.height) {
        const area = coords.width * coords.height;
        if (area > 0 && area < minArea) {
          minArea = area;
          best = el;
        }
      }
    }

    return best;
  }

  /**
   * Builds a semantic selector from an element. Returns null when the element has nothing
   * identifying beyond its role, since a bare role (e.g. "View") would match many nodes.
   */
  _selectorFromElement(el) {
    if (!el) return null;
    const selector = {};
    if (el.type) selector.role = el.type;
    if (el.id && !el.id.startsWith("android:id/content")) selector.resource_id = el.id;
    if (el.label) selector.label = el.label;
    // An editable field's text is its current contents, which changes between runs
    else if (el.text && el.text.length < 50 && !this._isEditable(el)) selector.text = el.text;

    // A bare container id (e.g. a root LinearLayout) would replay as a tap on its center,
    // not where the agent actually tapped, so it does not count as identifying
    const isContainer = el.type && /Layout|ViewGroup/.test(el.type);
    const identifying = selector.label || selector.text || (selector.resource_id && !isContainer);
    if (!identifying && !this._isEditable(el)) return null;
    return selector;
  }

  _findCurrentlyFocusedSelector(elements) {
    if (!Array.isArray(elements)) return null;
    const focused = elements.find(el => el.focused);
    if (!focused) return null;

    const selector = {};
    if (focused.type) selector.role = focused.type;
    if (focused.id) selector.resource_id = focused.id;
    if (focused.label) selector.label = focused.label;
    selector.editable = true;
    return selector;
  }

  /**
   * Synthesizes and saves a recipe automatically from the actions observed in this session.
   *
   * @param {string} sessionId
   * @param {object} [options]
   * @param {string} [options.name]
   * @param {string} [options.description]
   * @returns {object|null} Synthesized recipe or null if insufficient actions
   */
  synthesizeRecipe(sessionId, options = {}) {
    const session = this._getSession(sessionId);
    const actions = session.actions;

    // A workflow often crosses into helper packages (e.g. Settings search lives in
    // com.google.android.settings.intelligence), so key the recipe on the app it started in
    const pkg = (actions[0] && actions[0].package) || session.activePackage;
    if (!pkg || actions.length < 2) {
      return null;
    }

    const pkgSlug = pkg.replace(/[^a-zA-Z0-9]/g, "-").replace(/-+/g, "-");
    const nameHash = crypto.randomBytes(3).toString("hex");
    const recipeName = options.name || `${pkgSlug}-auto-${nameHash}`;

    // Parameter extraction: generalize typed/inserted texts into parameters
    const params = {};
    const steps = [];
    let paramCounter = 1;
    const coordinateSteps = [];

    actions.forEach((act, idx) => {
      const stepId = idx + 1;
      const step = {
        id: stepId,
        action: act.action,
        note: act.note
      };

      if (act.target_selector) {
        step.target_selector = act.target_selector;
      }

      if (act.text && act.text.length <= 3) {
        // Short literals (e.g. "OK", "1") are kept as-is rather than parameterized
        step.params = { text: act.text };
      } else if (act.text) {
        // Longer text looks like a variable value, so convert it to a parameter
        const paramKey = `input_text_${paramCounter++}`;
        params[paramKey] = {
          type: "string",
          description: `Input text for step ${stepId}`,
          required: true
        };
        step.params = { text: `{{${paramKey}}}` };
      }
      if (act.text && act.submit) {
        step.params.submit = true;
        step.is_submission = true; // runner never auto-retries uncertain submissions
      }
      if (act.desired_state) {
        step.params = { desired_state: act.desired_state };
      } else if (act.button) {
        step.params = { button: act.button };
      } else if (act.action === "click" && !act.target_selector) {
        step.params = { x: act.x, y: act.y };
        step.coordinate_fallback = true;
        coordinateSteps.push(stepId);
      }

      steps.push(step);
    });

    const recipe = {
      schema_version: 2,
      name: recipeName,
      description: options.description || `Automated recipe learned from agent workflow in ${pkg}`,
      package_name: pkg,
      version: "1.0.0",
      validation_status: "draft", // Automatically learned workflows must default to draft
      provenance: {
        author: "auto-learning-agent",
        created_at: new Date().toISOString(),
        source_session: sessionId,
        notes: `Automatically synthesized from ${actions.length} observed agent actions.` +
          (coordinateSteps.length ? ` Steps ${coordinateSteps.join(", ")} use raw screen coordinates (no label found) and may break on other screens.` : "")
      },
      params: Object.keys(params).length > 0 ? params : undefined,
      preconditions: {
        package_foreground: pkg
      },
      steps,
      on_failure: "stop"
    };

    // Save recipe to durable store
    try {
      this.store.saveRecipe(recipe, { sessionId, clientName: "auto-learning-agent" });
      audit.log("recipe_auto_synthesized", {
        recipe: recipeName,
        package: pkg,
        steps_count: steps.length
      });

      // Clear recorded actions for next workflow turn
      session.actions = [];
      return recipe;
    } catch (err) {
      process.stderr.write(`[learner] Failed to auto-save recipe: ${err.message}\n`);
      return null;
    }
  }
}

module.exports = AutomatedRecipeLearner;
