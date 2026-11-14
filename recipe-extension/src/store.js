"use strict";

const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const config = require("./config");
const { validateRecipe, validateGuidance } = require("./types");
const audit = require("./audit");

class RecipeStore {
  constructor(storeDir = config.STORE_DIR) {
    this.storeDir = storeDir;
    this.recipesDir = path.join(storeDir, "recipes");
    this.guidanceDir = path.join(storeDir, "guidance");
    this.versionHash = this._computeInitialHash();
    this.ensureDirectories();
  }

  ensureDirectories() {
    try {
      if (!fs.existsSync(this.recipesDir)) {
        fs.mkdirSync(this.recipesDir, { recursive: true });
      }
      if (!fs.existsSync(this.guidanceDir)) {
        fs.mkdirSync(this.guidanceDir, { recursive: true });
      }
    } catch (err) {
      process.stderr.write(`[recipe-store] Failed to create directories: ${err.message}\n`);
    }
  }

  _computeInitialHash() {
    return crypto.randomBytes(8).toString("hex");
  }

  _bumpVersionHash() {
    this.versionHash = crypto.randomBytes(8).toString("hex");
  }

  getStoreVersionHash() {
    return this.versionHash;
  }

  /**
   * Seed store with bundled default recipes and guidance if empty.
   */
  seedDefaults(bundledRecipesDir = config.BUNDLED_RECIPES_DIR, bundledGuidanceDir = config.BUNDLED_GUIDANCE_DIR) {
    this.ensureDirectories();

    // Seed guidance
    if (fs.existsSync(bundledGuidanceDir)) {
      const files = fs.readdirSync(bundledGuidanceDir).filter(f => f.endsWith(".json"));
      for (const file of files) {
        const targetPath = path.join(this.guidanceDir, file);
        if (!fs.existsSync(targetPath)) {
          const content = fs.readFileSync(path.join(bundledGuidanceDir, file), "utf8");
          fs.writeFileSync(targetPath, content, "utf8");
        }
      }
    }

    // Seed recipes
    if (fs.existsSync(bundledRecipesDir)) {
      const files = fs.readdirSync(bundledRecipesDir).filter(f => f.endsWith(".json"));
      for (const file of files) {
        const targetPath = path.join(this.recipesDir, file);
        if (!fs.existsSync(targetPath)) {
          const content = fs.readFileSync(path.join(bundledRecipesDir, file), "utf8");
          fs.writeFileSync(targetPath, content, "utf8");
        }
      }
    }

    this._bumpVersionHash();
  }

  /**
   * List recipes with optional filtering.
   */
  listRecipes(filter = {}) {
    this.ensureDirectories();
    const results = [];
    if (!fs.existsSync(this.recipesDir)) return results;

    const files = fs.readdirSync(this.recipesDir).filter(f => f.endsWith(".json"));
    for (const file of files) {
      try {
        const raw = fs.readFileSync(path.join(this.recipesDir, file), "utf8");
        const recipe = JSON.parse(raw);

        // Filter checks
        const pkg = recipe.package_name || recipe.app;
        if (filter.package_name && pkg !== filter.package_name) {
          continue;
        }
        if (filter.validation_status && recipe.validation_status !== filter.validation_status) {
          continue;
        }
        if (filter.query) {
          const q = filter.query.toLowerCase();
          const match = (recipe.name && recipe.name.toLowerCase().includes(q)) ||
                        (recipe.description && recipe.description.toLowerCase().includes(q));
          if (!match) continue;
        }

        // Return compact summary
        results.push({
          name: recipe.name,
          package_name: pkg,
          description: recipe.description,
          version: recipe.version || "1.0.0",
          validation_status: recipe.validation_status || "draft",
          params_summary: recipe.params ? Object.keys(recipe.params) : [],
          steps_count: Array.isArray(recipe.steps) ? recipe.steps.length : 0
        });
      } catch (err) {
        process.stderr.write(`[recipe-store] Failed to parse ${file}: ${err.message}\n`);
      }
    }

    return results.sort((a, b) => a.name.localeCompare(b.name));
  }

  /**
   * Get full recipe by name.
   */
  getRecipe(name) {
    this.ensureDirectories();
    const filePath = path.join(this.recipesDir, `${name}.json`);
    if (!fs.existsSync(filePath)) {
      return null;
    }
    try {
      const raw = fs.readFileSync(filePath, "utf8");
      return JSON.parse(raw);
    } catch (err) {
      process.stderr.write(`[recipe-store] Decode error for ${name}: ${err.message}\n`);
      return null;
    }
  }

  /**
   * Save or update a recipe.
   */
  saveRecipe(recipeData, clientInfo = {}) {
    this.ensureDirectories();

    const validation = validateRecipe(recipeData);
    if (!validation.valid) {
      throw new Error(`Recipe validation failed: ${validation.errors.join("; ")}`);
    }

    // Clone and sanitize
    const recipe = JSON.parse(JSON.stringify(recipeData));

    // Ensure validation status is explicitly set (defaults to draft for safety)
    recipe.validation_status = recipe.validation_status || "draft";

    // Provenance
    recipe.provenance = {
      author: recipe.provenance?.author || clientInfo.clientName || "agent",
      created_at: recipe.provenance?.created_at || new Date().toISOString(),
      updated_at: new Date().toISOString(),
      source_session: clientInfo.sessionId || "unknown",
      notes: recipe.provenance?.notes || "Saved via Mobile MCP recipe extension"
    };

    const filePath = path.join(this.recipesDir, `${recipe.name}.json`);
    fs.writeFileSync(filePath, JSON.stringify(recipe, null, 2), "utf8");
    this._bumpVersionHash();

    audit.log("recipe_saved", {
      name: recipe.name,
      package: recipe.package_name || recipe.app,
      status: recipe.validation_status
    });

    return {
      success: true,
      name: recipe.name,
      status: recipe.validation_status,
      version: recipe.version || "1.0.0"
    };
  }

  /**
   * Explicitly delete a recipe by name.
   */
  deleteRecipe(name) {
    this.ensureDirectories();
    const filePath = path.join(this.recipesDir, `${name}.json`);
    if (!fs.existsSync(filePath)) {
      return false;
    }
    fs.unlinkSync(filePath);
    this._bumpVersionHash();

    audit.log("recipe_deleted", { name });
    return true;
  }

  /**
   * List all guidance packages available.
   */
  listGuidance() {
    this.ensureDirectories();
    const results = [];
    if (!fs.existsSync(this.guidanceDir)) return results;

    const files = fs.readdirSync(this.guidanceDir).filter(f => f.endsWith(".json"));
    for (const file of files) {
      try {
        const raw = fs.readFileSync(path.join(this.guidanceDir, file), "utf8");
        const doc = JSON.parse(raw);
        results.push({
          package_name: doc.package_name,
          version: doc.version || "1.0.0",
          guidance_items_count: Array.isArray(doc.guidance) ? doc.guidance.length : 0,
          updated_at: doc.updated_at
        });
      } catch (err) {
        process.stderr.write(`[recipe-store] Failed to parse guidance ${file}: ${err.message}\n`);
      }
    }
    return results;
  }

  /**
   * Get guidance for a specific package.
   */
  getGuidance(packageName) {
    this.ensureDirectories();
    const filePath = path.join(this.guidanceDir, `${packageName}.json`);
    if (!fs.existsSync(filePath)) {
      return null;
    }
    try {
      const raw = fs.readFileSync(filePath, "utf8");
      return JSON.parse(raw);
    } catch (err) {
      process.stderr.write(`[recipe-store] Failed to read guidance for ${packageName}: ${err.message}\n`);
      return null;
    }
  }

  /**
   * Save guidance for a package.
   */
  saveGuidance(guidanceData) {
    this.ensureDirectories();
    const validation = validateGuidance(guidanceData);
    if (!validation.valid) {
      throw new Error(`Guidance validation failed: ${validation.errors.join("; ")}`);
    }

    const doc = JSON.parse(JSON.stringify(guidanceData));
    doc.updated_at = new Date().toISOString();
    doc.version = doc.version || "1.0.0";

    const filePath = path.join(this.guidanceDir, `${doc.package_name}.json`);
    fs.writeFileSync(filePath, JSON.stringify(doc, null, 2), "utf8");
    this._bumpVersionHash();

    audit.log("guidance_saved", { package: doc.package_name });
    return {
      success: true,
      package_name: doc.package_name,
      items_count: doc.guidance.length
    };
  }
}

module.exports = RecipeStore;
