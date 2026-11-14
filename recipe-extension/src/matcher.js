"use strict";

/**
 * Parses raw text or json tree output from mobile_list_elements_on_screen.
 * @param {string|object} rawTree
 * @returns {Array<object>} Array of parsed elements
 */
function parseAccessibilityTree(rawTree) {
  if (!rawTree) return [];

  // If already parsed array or object
  if (Array.isArray(rawTree)) return rawTree;
  if (typeof rawTree === "object") {
    if (Array.isArray(rawTree.elements)) return rawTree.elements;
    return [rawTree];
  }

  const str = String(rawTree).trim();

  // Try JSON parsing
  if (str.startsWith("Found these elements on screen:") || str.startsWith("{") || str.startsWith("[")) {
    try {
      const jsonStart = str.indexOf("[");
      const jsonEnd = str.lastIndexOf("]");
      if (jsonStart !== -1 && jsonEnd !== -1) {
        const jsonStr = str.slice(jsonStart, jsonEnd + 1);
        const parsed = JSON.parse(jsonStr);
        if (Array.isArray(parsed)) {
          return parsed.map(el => {
            const coords = el.coordinates || {};
            const x = coords.x ?? 0;
            const y = coords.y ?? 0;
            const w = coords.width ?? 0;
            const h = coords.height ?? 0;
            return {
              ref: el.ref,
              type: el.type,
              text: el.text,
              label: el.label,
              name: el.name,
              value: el.value,
              id: el.identifier,
              coordinates: { x, y, width: w, height: h },
              center: { x: Math.round(x + w / 2), y: Math.round(y + h / 2) },
              focused: Boolean(el.focused),
              selected: Boolean(el.selected),
              checked: Boolean(el.checked),
              disabled: el.enabled === false
            };
          });
        }
      }
    } catch {
      // Fall through to text parsing
    }
  }

  // Parse Text Format lines
  const lines = str.split("\n");
  const elements = [];

  for (const line of lines) {
    const trimmed = line.trim();
    // Skip empty lines or header line
    if (!trimmed || trimmed.startsWith("One element per line:")) continue;

    // Pattern: @eXX Type [attributes] at=X,Y size=WxH [states]
    const refMatch = trimmed.match(/^(@\w+)\s+([^\s]+)/);
    if (!refMatch) continue;

    const ref = refMatch[1];
    const type = refMatch[2];

    const getAttr = (key) => {
      // Matches key="value" or key=value
      const m = trimmed.match(new RegExp(`${key}="((?:\\\\.|[^"\\\\])*)"`)) || trimmed.match(new RegExp(`${key}=([^\\s]+)`));
      if (!m) return undefined;
      const rawVal = m[1];
      try {
        return JSON.parse(`"${rawVal}"`);
      } catch {
        return rawVal;
      }
    };

    const text = getAttr("text");
    const label = getAttr("label");
    const name = getAttr("name");
    const value = getAttr("value");
    const id = getAttr("id");

    const atMatch = trimmed.match(/at=(-?\d+),(-?\d+)/);
    const sizeMatch = trimmed.match(/size=(\d+)x(\d+)/);

    const x = atMatch ? parseInt(atMatch[1], 10) : 0;
    const y = atMatch ? parseInt(atMatch[2], 10) : 0;
    const w = sizeMatch ? parseInt(sizeMatch[1], 10) : 0;
    const h = sizeMatch ? parseInt(sizeMatch[2], 10) : 0;

    // Check states: must appear as standalone flags in the element line
    // e.g. "focused" or "[focused]"
    const isFocused = /\b(focused|\[focused\])\b/.test(trimmed);
    const isSelected = /\b(selected|\[selected\])\b/.test(trimmed);
    const isChecked = /\b(checked|\[checked\])\b/.test(trimmed);
    const isDisabled = /\b(disabled|\[disabled\])\b/.test(trimmed);

    elements.push({
      ref,
      type,
      text,
      label,
      name,
      value,
      id,
      coordinates: { x, y, width: w, height: h },
      center: { x: Math.round(x + w / 2), y: Math.round(y + h / 2) },
      focused: isFocused,
      selected: isSelected,
      checked: isChecked,
      disabled: isDisabled
    });
  }

  return elements;
}

/**
 * Matches elements against a declarative target selector.
 * @param {Array<object>|string} tree
 * @param {object} selector
 * @returns {{ found: boolean, ambiguous: boolean, element?: object, matches: Array<object>, error?: string }}
 */
function findElement(tree, selector = {}) {
  const elements = Array.isArray(tree) ? tree : parseAccessibilityTree(tree);

  if (!selector || Object.keys(selector).length === 0) {
    return {
      found: false,
      ambiguous: false,
      matches: [],
      error: "Selector cannot be empty"
    };
  }

  const matches = elements.filter(el => {
    // Role / Type matching (supports short e.g. "EditText" or full "android.widget.EditText")
    if (selector.role) {
      const elType = el.type || "";
      const expectedRole = selector.role;
      const typeMatches = elType === expectedRole || 
                          elType.endsWith("." + expectedRole) ||
                          expectedRole.endsWith("." + elType);
      if (!typeMatches) return false;
    }

    // Editable check
    if (selector.editable !== undefined) {
      const isEditable = (el.type && el.type.includes("EditText")) || el.editable === true;
      if (isEditable !== selector.editable) return false;
    }

    // ID / Resource-ID matching
    if (selector.resource_id || selector.id) {
      const expectedId = selector.resource_id || selector.id;
      const elId = el.id || "";
      const idMatches = elId === expectedId || elId.endsWith("/" + expectedId);
      if (!idMatches) return false;
    }

    // Exact text matching
    if (selector.text !== undefined) {
      if ((el.text ?? "") !== selector.text && (el.value ?? "") !== selector.text) {
        return false;
      }
    }

    // Substring text matching
    if (selector.text_contains !== undefined) {
      const combinedText = ((el.text ?? "") + " " + (el.value ?? "")).toLowerCase();
      if (!combinedText.includes(selector.text_contains.toLowerCase())) {
        return false;
      }
    }

    // Exact label matching
    if (selector.label !== undefined) {
      if ((el.label ?? "") !== selector.label) return false;
    }

    // Substring label matching
    if (selector.label_contains !== undefined) {
      if (!((el.label ?? "").toLowerCase().includes(selector.label_contains.toLowerCase()))) {
        return false;
      }
    }

    // Focus state matching (from the element node itself)
    if (selector.focused !== undefined) {
      if (el.focused !== selector.focused) return false;
    }

    // Checked state matching
    if (selector.checked !== undefined) {
      if (el.checked !== selector.checked) return false;
    }

    // Selected state matching
    if (selector.selected !== undefined) {
      if (el.selected !== selector.selected) return false;
    }

    return true;
  });

  if (matches.length === 0) {
    return {
      found: false,
      ambiguous: false,
      matches: [],
      error: `No element matched selector: ${JSON.stringify(selector)}`
    };
  }

  if (matches.length > 1) {
    return {
      found: true,
      ambiguous: true,
      matches,
      error: `Ambiguous selector matched ${matches.length} elements: ${JSON.stringify(selector)}. Refine selector to avoid mis-clicking.`
    };
  }

  return {
    found: true,
    ambiguous: false,
    element: matches[0],
    matches
  };
}

module.exports = {
  parseAccessibilityTree,
  findElement
};
