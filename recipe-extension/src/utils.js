"use strict";

/**
 * Normalizes text for comparison.
 * Preserves newlines and spaces, but applies standard Unicode NFC normalization.
 */
function normalizeText(str) {
  if (typeof str !== "string") return "";
  return str.normalize("NFC");
}

/**
 * Compares expected text with actual text.
 * Strictly verifies content, not just length.
 * @param {string} expected
 * @param {string} actual
 * @returns {{ match: boolean, expectedLen: number, actualLen: number, diffHint?: string }}
 */
function compareExactText(expected, actual) {
  const normExpected = normalizeText(expected);
  const normActual = normalizeText(actual);

  if (normExpected === normActual) {
    return {
      match: true,
      expectedLen: normExpected.length,
      actualLen: normActual.length
    };
  }

  // Find first point of divergence for concise diagnostic diff
  let mismatchIndex = -1;
  const minLen = Math.min(normExpected.length, normActual.length);
  for (let i = 0; i < minLen; i++) {
    if (normExpected[i] !== normActual[i]) {
      mismatchIndex = i;
      break;
    }
  }
  if (mismatchIndex === -1 && normExpected.length !== normActual.length) {
    mismatchIndex = minLen;
  }

  const snippetStart = Math.max(0, mismatchIndex - 20);
  const expSnippet = normExpected.slice(snippetStart, snippetStart + 40);
  const actSnippet = normActual.slice(snippetStart, snippetStart + 40);

  const diffHint = `Divergence at index ${mismatchIndex}: expected "...${JSON.stringify(expSnippet)}..." but got "...${JSON.stringify(actSnippet)}..." (length exp=${normExpected.length}, act=${normActual.length})`;

  return {
    match: false,
    expectedLen: normExpected.length,
    actualLen: normActual.length,
    mismatchIndex,
    diffHint
  };
}

/**
 * Sanitizes an object or string by masking suspected credentials, tokens, or PII.
 */
function sanitizeForLogging(obj) {
  if (typeof obj === "string") {
    return obj
      .replace(/(bearer\s+)[A-Za-z0-9_\-\.]{15,}/gi, "$1[REDACTED]")
      .replace(/(password|passwd|secret|api[_-]?key)=([^&\s]+)/gi, "$1=[REDACTED]");
  }
  if (!obj || typeof obj !== "object") return obj;

  if (Array.isArray(obj)) {
    return obj.map(sanitizeForLogging);
  }

  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    const lk = k.toLowerCase();
    if (lk.includes("password") || lk.includes("secret") || lk.includes("token") || lk.includes("auth") || lk.includes("key") || lk.includes("credential")) {
      out[k] = "[REDACTED]";
    } else {
      out[k] = sanitizeForLogging(v);
    }
  }
  return out;
}

module.exports = {
  normalizeText,
  compareExactText,
  sanitizeForLogging
};
