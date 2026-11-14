"use strict";

const fs = require("node:fs");
const path = require("node:path");
const config = require("./config");
const { sanitizeForLogging } = require("./utils");

class AuditLogger {
  constructor(logFilePath = config.AUDIT_LOG_FILE) {
    this.logFilePath = logFilePath;
    this.enabled = true;
  }

  log(eventType, details = {}) {
    if (!this.enabled) return;

    try {
      const dir = path.dirname(this.logFilePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      // Sanitize details to guarantee no literal sensitive bodies or tokens are written
      const sanitized = sanitizeForLogging(details);

      // Never log full chat message bodies or secret fields
      if (sanitized.message_text) {
        sanitized.message_len = sanitized.message_text.length;
        delete sanitized.message_text;
      }
      if (sanitized.text && typeof sanitized.text === "string" && sanitized.text.length > 30) {
        sanitized.text_preview = sanitized.text.slice(0, 15) + "...[" + sanitized.text.length + " chars]";
        delete sanitized.text;
      }

      const entry = {
        timestamp: new Date().toISOString(),
        event: eventType,
        ...sanitized
      };

      fs.appendFileSync(this.logFilePath, JSON.stringify(entry) + "\n", "utf8");
    } catch (err) {
      // Do not crash server on audit log write failure
      process.stderr.write(`[audit-logger error] Failed to append: ${err.message}\n`);
    }
  }
}

module.exports = new AuditLogger();
