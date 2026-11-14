"use strict";

/**
 * Supported declarative actions in recipes.
 * Strictly declarative - NO arbitrary code or shell execution permitted.
 */
const ALLOWED_ACTIONS = new Set([
  "click",
  "type",
  "press",
  "wait",
  "swipe",
  "helper_insert_text",
  "helper_thinking_state",
  "clear_field",
  "read_text"
]);

const ALLOWED_VALIDATION_STATUSES = new Set([
  "draft",
  "validated",
  "stale"
]);

const ALLOWED_FAILURE_POLICIES = new Set([
  "stop",
  "skip"
]);

/**
 * Validates a recipe structure.
 * @param {object} recipe
 * @returns {{ valid: boolean, errors: string[] }}
 */
function validateRecipe(recipe) {
  const errors = [];

  if (!recipe || typeof recipe !== "object" || Array.isArray(recipe)) {
    return { valid: false, errors: ["Recipe must be an object"] };
  }

  // Schema version check (Ghost OS v2 standard)
  if (recipe.schema_version !== 2) {
    errors.push("Recipe 'schema_version' must be exactly 2");
  }

  // Name check
  if (!recipe.name || typeof recipe.name !== "string" || !/^[a-zA-Z0-9_-]+$/.test(recipe.name)) {
    errors.push("Recipe 'name' is required and must be alphanumeric with hyphens/underscores");
  }

  // Description check
  if (!recipe.description || typeof recipe.description !== "string") {
    errors.push("Recipe 'description' is required");
  }

  // Package identity check
  const pkg = recipe.package_name || recipe.app;
  if (!pkg || typeof pkg !== "string") {
    errors.push("Recipe must specify 'package_name' or 'app'");
  }

  // Validation status
  if (recipe.validation_status && !ALLOWED_VALIDATION_STATUSES.has(recipe.validation_status)) {
    errors.push(`Invalid validation_status '${recipe.validation_status}'. Must be one of: draft, validated, stale`);
  }

  // Failure policy
  if (recipe.on_failure && !ALLOWED_FAILURE_POLICIES.has(recipe.on_failure)) {
    errors.push(`Invalid on_failure '${recipe.on_failure}'. Must be 'stop' or 'skip'`);
  }

  // Parameters validation
  if (recipe.params && typeof recipe.params === "object") {
    for (const [pName, pDef] of Object.entries(recipe.params)) {
      if (!pDef || typeof pDef !== "object") {
        errors.push(`Parameter '${pName}' must be an object definition`);
      } else if (!pDef.type || !["string", "number", "boolean"].includes(pDef.type)) {
        errors.push(`Parameter '${pName}' must specify a valid type (string, number, boolean)`);
      }
    }
  }

  // Steps validation
  if (!Array.isArray(recipe.steps) || recipe.steps.length === 0) {
    errors.push("Recipe must have a non-empty 'steps' array");
  } else {
    recipe.steps.forEach((step, idx) => {
      const stepId = step.id !== undefined ? step.id : idx + 1;
      if (!step.action || typeof step.action !== "string") {
        errors.push(`Step ${stepId} missing required 'action'`);
      } else if (!ALLOWED_ACTIONS.has(step.action)) {
        errors.push(`Step ${stepId} action '${step.action}' is not supported. Allowed actions: ${Array.from(ALLOWED_ACTIONS).join(", ")}`);
      }

      // Prohibit dangerous shell/eval parameters
      if (step.params && typeof step.params === "object") {
        const forbiddenKeys = ["shell", "command", "exec", "eval", "spawn"];
        for (const k of forbiddenKeys) {
          if (k in step.params) {
            errors.push(`Step ${stepId} contains forbidden execution parameter '${k}'`);
          }
        }
      }

      if (step.on_failure && !ALLOWED_FAILURE_POLICIES.has(step.on_failure)) {
        errors.push(`Step ${stepId} invalid on_failure '${step.on_failure}'. Must be 'stop' or 'skip'`);
      }
    });
  }

  return {
    valid: errors.length === 0,
    errors
  };
}

/**
 * Validates guidance document.
 * @param {object} guidanceDoc
 * @returns {{ valid: boolean, errors: string[] }}
 */
function validateGuidance(guidanceDoc) {
  const errors = [];
  if (!guidanceDoc || typeof guidanceDoc !== "object" || Array.isArray(guidanceDoc)) {
    return { valid: false, errors: ["Guidance document must be an object"] };
  }

  if (!guidanceDoc.package_name || typeof guidanceDoc.package_name !== "string") {
    errors.push("Guidance requires 'package_name' string");
  }

  if (!Array.isArray(guidanceDoc.guidance) || guidanceDoc.guidance.length === 0) {
    errors.push("Guidance document must have a non-empty 'guidance' string array");
  } else {
    for (const item of guidanceDoc.guidance) {
      if (typeof item !== "string" || item.trim().length === 0) {
        errors.push("Guidance items must be non-empty strings");
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors
  };
}

module.exports = {
  ALLOWED_ACTIONS,
  ALLOWED_VALIDATION_STATUSES,
  ALLOWED_FAILURE_POLICIES,
  validateRecipe,
  validateGuidance
};
