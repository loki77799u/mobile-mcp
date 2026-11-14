"use strict";

const crypto = require("node:crypto");
const config = require("./config");
const audit = require("./audit");

class GuidanceDeliveryManager {
  constructor(store) {
    this.store = store;
    // Map of session delivery keys: `${sessionId}:${deviceId}:${packageName}:${storeVersionHash}` -> timestamp
    this.deliveredRegistry = new Map();
  }

  /**
   * Resets the delivery registry (useful for test isolation).
   */
  reset() {
    this.deliveredRegistry.clear();
  }

  /**
   * Generates a safe deduplication key containing no confidential content.
   */
  getDeduplicationKey(sessionId, deviceId, packageName, storeVersionHash) {
    const sId = sessionId || "default-session";
    const dId = deviceId || "default-device";
    const pkg = packageName || "unknown-pkg";
    const vHash = storeVersionHash || this.store.getStoreVersionHash();
    return `${sId}::${dId}::${pkg}::${vHash}`;
  }

  /**
   * Checks whether guidance has already been delivered for this session/device/package/version.
   */
  hasDelivered(sessionId, deviceId, packageName) {
    const key = this.getDeduplicationKey(sessionId, deviceId, packageName);
    const deliveredAt = this.deliveredRegistry.get(key);
    if (!deliveredAt) return false;

    // Check TTL
    if (Date.now() - deliveredAt > config.DEFAULTS.SESSION_GUIDANCE_TTL_MS) {
      this.deliveredRegistry.delete(key);
      return false;
    }
    return true;
  }

  /**
   * Marks guidance as delivered for this session/device/package/version.
   */
  markDelivered(sessionId, deviceId, packageName) {
    const key = this.getDeduplicationKey(sessionId, deviceId, packageName);
    this.deliveredRegistry.set(key, Date.now());
  }

  /**
   * Extracts package name from tool call context without making an extra device round-trip.
   * Reuses foreground app information, tool arguments, or returned screen elements.
   *
   * @param {string} toolName
   * @param {object} toolArgs
   * @param {any} toolResult
   * @returns {string|null}
   */
  detectPackage(toolName, toolArgs = {}, toolResult = null) {
    // 1. Direct package argument (e.g. mobile_launch_app, mobile_clear_app_data)
    if (toolArgs && typeof toolArgs.packageName === "string") {
      return toolArgs.packageName.trim();
    }

    // 2. Result of mobile_get_foreground_app
    if (toolName === "mobile_get_foreground_app" && toolResult) {
      const resStr = typeof toolResult === "string" ? toolResult : JSON.stringify(toolResult);
      const pkgMatch = resStr.match(/"package":\s*"([^"]+)"/) || 
                       resStr.match(/package=([^\s,}]+)/) ||
                       resStr.match(/\b(com\.[a-zA-Z0-9_\.]+)\b/);
      if (pkgMatch) {
        return pkgMatch[1];
      }
    }

    // 3. Screen element IDs (e.g. com.openai.chatgpt:id/...)
    if (toolName === "mobile_list_elements_on_screen" && toolResult) {
      const resStr = typeof toolResult === "string" ? toolResult : JSON.stringify(toolResult);
      // Fast check for known patterns
      const idMatch = resStr.match(/([a-zA-Z0-9_\.]+):id\//);
      if (idMatch && idMatch[1] && !idMatch[1].startsWith("android")) {
        return idMatch[1];
      }
    }

    return null;
  }

  /**
   * Creates compact guidance and recipe advisory text for delivery.
   *
   * @param {string} packageName
   * @returns {string|null}
   */
  buildGuidanceAdvisory(packageName) {
    const guidanceDoc = this.store.getGuidance(packageName);
    const recipes = this.store.listRecipes({ package_name: packageName });

    if (!guidanceDoc && recipes.length === 0) {
      return null;
    }

    const lines = [];
    lines.push(`\n---\n[Mobile Recipe Advisory: App '${packageName}']`);

    if (guidanceDoc && Array.isArray(guidanceDoc.guidance) && guidanceDoc.guidance.length > 0) {
      lines.push(`• Operational Guidance (${guidanceDoc.guidance.length} items; call mobile_guidance_list for full list):`);
      // Include top critical alerts or first 3-4 items
      const topItems = guidanceDoc.guidance.slice(0, 4);
      for (const item of topItems) {
        lines.push(`  - ${item}`);
      }
      if (guidanceDoc.guidance.length > 4) {
        lines.push(`  - (...and ${guidanceDoc.guidance.length - 4} more guidance items available)`);
      }
    }

    if (recipes.length > 0) {
      lines.push(`• Relevant Workflows/Recipes:`);
      for (const r of recipes) {
        lines.push(`  - ${r.name} [status: ${r.validation_status}]: ${r.description}`);
      }
      lines.push(`• Tip: Execute with mobile_recipe_run or inspect with mobile_recipe_show.`);
    }

    lines.push(`---`);
    return lines.join("\n");
  }

  /**
   * Augments an upstream tool response with deduplicated guidance if a relevant package is detected.
   *
   * @param {string} toolName
   * @param {object} toolArgs
   * @param {object} upstreamResponse - Standard MCP tool response object { content, isError }
   * @param {object} clientSession - { sessionId, deviceId }
   * @returns {object} Augmented response (or original if not applicable)
   */
  augmentResponseIfNeeded(toolName, toolArgs, upstreamResponse, clientSession = {}) {
    // Never modify error responses or empty responses
    if (!upstreamResponse || upstreamResponse.isError) {
      return upstreamResponse;
    }

    const detectedPackage = this.detectPackage(toolName, toolArgs, upstreamResponse);
    if (!detectedPackage) {
      return upstreamResponse;
    }

    const sessionId = clientSession.sessionId || "default-session";
    const deviceId = toolArgs?.device || clientSession.deviceId || "default-device";

    // Deduplication check
    if (this.hasDelivered(sessionId, deviceId, detectedPackage)) {
      return upstreamResponse;
    }

    // Build compact advisory
    const advisory = this.buildGuidanceAdvisory(detectedPackage);
    if (!advisory) {
      return upstreamResponse;
    }

    // Mark as delivered for this session scope
    this.markDelivered(sessionId, deviceId, detectedPackage);

    audit.log("guidance_delivered", {
      package: detectedPackage,
      sessionId,
      deviceId,
      tool: toolName
    });

    // Append to text content while strictly preserving upstream results
    const newContent = Array.isArray(upstreamResponse.content)
      ? [...upstreamResponse.content]
      : [];

    if (newContent.length > 0 && newContent[0].type === "text") {
      newContent[0] = {
        ...newContent[0],
        text: newContent[0].text + "\n" + advisory
      };
    } else {
      newContent.push({
        type: "text",
        text: advisory
      });
    }

    return {
      ...upstreamResponse,
      content: newContent
    };
  }
}

module.exports = GuidanceDeliveryManager;
