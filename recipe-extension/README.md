# Mobile MCP Recipe & Operational Guidance Extension

A client-independent recipe and operational guidance extension for Mobile MCP (`@mobilenext/mobile-mcp`), using Ghost OS (`ghostwright/ghost-os`) as an architectural reference.

---

## 1. Overview & Architecture

### The Problem
When an agent automates mobile applications (e.g., ChatGPT Android), it discovers critical application quirks (e.g., typing errors, focus traps, state resets) through trial and error. If these workflows are captured only as client-specific prompts, skills, or ephemeral logs, future sessions in Codex, Claude, Cursor, or other MCP clients must repeat the same round-trips, consuming excessive context tokens and risking regressions.

### The Solution
A lightweight, zero-dependency Node.js MCP stdio proxy that wraps `@mobilenext/mobile-mcp` without patching ephemeral npx caches or duplicating upstream tools.

```
┌────────────────────────────────────────────────────────┐
│  MCP Clients (Codex, Claude Desktop/Code, Cursor)      │
└───────────────────────────┬────────────────────────────┘
                            │ stdio (JSON-RPC 2.0)
                            ▼
┌────────────────────────────────────────────────────────┐
│       mobile-mcp-recipe-server (This Proxy)            │
│  - Merged tools/list (all 29 upstream + 9 extension)   │
│  - Context-aware guidance delivery (app detection)     │
│  - Session deduplication registry                      │
│  - Semantic selector resolution (fresh AX trees)       │
│  - Declarative recipe runner & safety boundaries       │
│  - Verified exact text insertion engine                │
│  - Sanitized audit logger                              │
└─────────────┬────────────────────────────┬─────────────┘
              │ stdio                      │ filesystem
              ▼                            ▼
┌───────────────────────────┐  ┌─────────────────────────┐
│ @mobilenext/mobile-mcp    │  │ ~/.mobile-mcp/recipes/  │
│ (Upstream Mobile MCP)     │  │  ├── guidance/          │
│  - ADB / go-ios / robots  │  │  ├── recipes/           │
│  - Real device / emulator │  │  └── audit.log          │
└───────────────────────────┘  └─────────────────────────┘
```

---

## 2. Completed Capabilities

### Upstream Preservation
- Preserves all 29 standard upstream Mobile MCP tools, schemas, descriptions, and approval policies (`mobile_batch_commands`, `mobile_click_on_screen_at_coordinates`, `mobile_press_button`, etc.).
- Preserves full upstream results, errors, and device-selection requirements (`device` argument).

### 10 Extension Tools
| Tool | Purpose |
|---|---|
| `mobile_recipe_list` | List installed recipes with descriptions, parameters, and status |
| `mobile_recipe_show` | Inspect full declarative recipe JSON |
| `mobile_recipe_run` | Execute recipe with fresh selector resolution and bounded verification |
| `mobile_recipe_save` | Save synthesized/learned recipe (defaults to `draft` validation status) |
| `mobile_recipe_delete` | Explicitly delete an installed recipe by name |
| `mobile_recipe_auto_learn` | Automatically synthesize and save a declarative recipe from turn actions |
| `mobile_guidance_list` | View compact operational guidance and known quirks for an app package |
| `mobile_guidance_save` | Save or update operational guidance items |
| `mobile_helper_insert_text` | Exact text insertion via node-level focus check, clipboard paste & readback check |
| `mobile_helper_thinking_state`| Check and configure ChatGPT Android Thinking Mode state before send |

### Automated Recipe Learning & Delivery Loop
- **Per-Turn Action Recording**: As an agent interacts with an app (`mobile_click_on_screen_at_coordinates`, `mobile_type_keys`, `mobile_helper_insert_text`), the proxy records the action trace and correlates screen coordinates with the preceding `mobile_list_elements_on_screen` accessibility tree.
- **Auto-Synthesis**: When a multi-step sequence completes, calling `mobile_recipe_auto_learn` (or triggering auto-synthesis) extracts semantic selectors (role, resource ID, accessibility label), generalizes literal texts into reusable `{{parameters}}`, and saves the recipe into `~/.mobile-mcp/recipes/recipes/` with status `draft`.
- **Automatic Delivery**: The newly learned recipe is immediately indexed into the store. When any future agent session in Codex, Claude, or Cursor observes that application package, the recipe is automatically surfaced in the context-aware guidance advisory.

### Context-Aware Automatic Guidance Delivery
- Detects active app package via outgoing arguments (`mobile_launch_app`), foreground queries (`mobile_get_foreground_app`), or accessibility element resource IDs.
- Appends compact markdown advisory block to tool response without modifying upstream payload.
- **Zero token cost for unrelated tasks**: Tasks interacting with settings or calculator receive 0 bytes recipe content.
- **Deduplication**: App guidance is delivered once per `(sessionId, deviceId, package, storeVersionHash)`. Subsequent tool calls do not repeat guidance.
- **Confidentiality**: Deduplication keys contain no prompt text or sensitive bodies.

### Reliable Execution Engine
- **Exact text comparison**: Character-for-character NFC normalized comparison. Length equality alone is strictly rejected.
- **Actual node focus**: Inspects element node state, avoiding tree header `[focused]` false positives.
- **Submission safety**: Unambiguously separates preparation from submission. Uncertain submissions return `ambiguous_submission: true` and are **never** auto-retried.
- **Declarative recipes**: Strictly rejects arbitrary shell or code execution.

---

## 3. Seeded ChatGPT Android Guidance & Workflows

**Package**: `com.openai.chatgpt`

### Seeded Guidance (`~/.mobile-mcp/recipes/guidance/com.openai.chatgpt.json`)
1. `mobile_type_keys` once changed `v1.2` to `v1. 2`; exact clipboard paste plus text comparison avoided this.
2. The accessibility tree header contains `[focused]`; focus checks must inspect the `EditText` node itself.
3. "Think harder" selection cleared after responses; required state must be checked before each send.
4. OFF still allowed "Worked" sections and tool activity; do not equate the switch with absence of internal reasoning.
5. Final answer text must be distinguished from thinking/tool UI.
6. Accessibility sometimes exposes complete offscreen reply text, avoiding needless scrolling.
7. Project instructions accepted 7,891 characters without displaying a counter; report absent counters honestly.
8. Source-file selection sometimes uploaded immediately without a separate Select button; verify the resulting Sources list.
9. New chats in the same Project may share context.
10. "Get Plus" or "Upgrade plan" is not an explicit current-plan label; infer Free plan cautiously.
11. Read current trees instead of storing screen coordinates.

### Seeded Recipes (`~/.mobile-mcp/recipes/recipes/`)
- `chatgpt-verified-paste.json` (Validated)
- `chatgpt-set-thinking-mode.json` (Validated)
- `chatgpt-send-prompt.json` (Validated)

---

## 4. Automated Test Results

Automated test suite located at `test/run-all-tests.js` executing 6 test suites against `test/fake-upstream.js`:

```
================================================================================
  MOBILE MCP RECIPE EXTENSION — AUTOMATED TEST HARNESS & VALIDATION
================================================================================

▶ Running Test Suite: Upstream MCP Protocol & Tool Compatibility
  ✔ initialize handshake and instruction augmentation passed
  ✔ tools/list preserved upstream tools and registered all 9 extension tools
  ✔ upstream tool call executed and returned faithful result
  ✔ unknown method returns standard JSON-RPC -32601 error
✔ Suite 1: Upstream compatibility verified successfully

▶ Running Test Suite: Context-Aware Guidance Delivery & Deduplication
  ✔ relevant recipe delivery triggered on relevant app detection
  ✔ deduplication within session scope verified (zero redundant token overhead)
  ✔ unrelated tasks receive zero recipe overhead
  ✔ recipe/guidance updates automatically re-deliver to client
  ✔ client restart isolation verified
  ✔ concurrent client isolation verified
  ✔ deduplication key confidentiality verified
✔ Suite 2: Context-aware guidance delivery verified successfully

▶ Running Test Suite: Exact Verified Text Insertion
  ✔ compareExactText correctly rejects same-length mismatch
  ✔ focus acquired on node and exact text inserted via clipboard paste
  ✔ mobile_type_keys spacing bug prevented by verified clipboard paste
  ✔ Unicode, punctuation, multiline content, and trailing newlines verified exactly
  ✔ 7,891-character instruction text verified character-for-character without truncation
  ✔ readback mismatch halts execution immediately
✔ Suite 3: Verified text insertion passed all checks

▶ Running Test Suite: Declarative Recipe Execution & Safety Boundaries
  ✔ parameterized declarative recipe executed and verified end-to-end
  ✔ ambiguous selector halted execution before mis-clicking
  ✔ missing selector stopped execution with clear diagnostic
  ✔ bounded wait condition timed out predictably without indefinite blocking
  ✔ uncertain submission safely halted without duplicate send attempts
✔ Suite 4: Declarative recipe runner passed all safety and verification tests

▶ Running Test Suite: Schema Validation & Sensitive Data Sanitization
  ✔ invalid schema version rejected
  ✔ arbitrary shell/code execution vectors strictly rejected by schema validator
  ✔ newly learned recipes default to 'draft' validation status
  ✔ explicit recipe deletion verified
  ✔ sensitive tokens and credentials scrubbed from logging
✔ Suite 5: Safety and sanitization verified successfully

▶ Running Test Suite: Performance, Context Overhead & Payload Measurements

  [Measurement 1: One-Time Schema Discovery]
  • Extension tools count: 9 tools
  • Schema payload size:   3,648 bytes (~912 tokens)
  • Overhead note:         Paid exactly once during client tools/list initialization.

  [Measurement 2: Unrelated App Task Overhead]
  • Target package:        com.android.settings
  • Added recipe bytes:    0 bytes (0 extra tokens)

  [Measurement 3: Context-Aware Advisory Delivery]
  • Target package:        com.openai.chatgpt
  • Delivered advisory:    1,171 bytes (~288 tokens)
  • Delivery frequency:    Delivered ONCE per session scope (deduplicated thereafter).

  [Measurement 4: End-to-End Task Comparison]
  ┌────────────────────────────────┬──────────────────┬──────────────────┐
  │ Metric                         │ Without Recipe   │ With Recipe Ext. │
  ├────────────────────────────────┼──────────────────┼──────────────────┤
  │ Client Model Turns (Tool Calls)│ 12               │ 2                │ (83% reduction)
  │ Model-Facing Payload Bytes     │ 14,910           │ 1,851            │ (88% reduction)
  │ Estimated Context Window Tokens│ ~3,728           │ ~463             │ (~88% savings)
  └────────────────────────────────┴──────────────────┴──────────────────┘

================================================================================
✅ ALL TEST SUITES PASSED (5.48s)
================================================================================
```

---

## 5. Installation & Client Configuration

The extension is a stdio proxy: clients launch it instead of `@mobilenext/mobile-mcp`, and it spawns the
pinned upstream (`@mobilenext/mobile-mcp@1.0.17`) itself. Requires Node.js 20+ and `adb` for Android.

```bash
git clone https://github.com/loki77799u/mobile-mcp.git
cd mobile-mcp/recipe-extension
npm test   # runs all 7 test suites; no device needed
```

Replace `/ABSOLUTE/PATH/TO` below with where you cloned the repo.

1. **Codex** (`~/.codex/config.toml`):
   ```toml
   [mcp_servers.mobile-mcp]
   command = "node"
   args = ["/ABSOLUTE/PATH/TO/mobile-mcp/recipe-extension/bin/mobile-mcp-recipe-server.js"]
   ```

2. **Claude Code**:
   ```bash
   claude mcp add mobile-mcp --scope user -- node /ABSOLUTE/PATH/TO/mobile-mcp/recipe-extension/bin/mobile-mcp-recipe-server.js
   ```

3. **Other MCP clients** (Claude Desktop, Cursor, etc.):
   ```json
   "mobile-mcp": {
     "command": "node",
     "args": ["/ABSOLUTE/PATH/TO/mobile-mcp/recipe-extension/bin/mobile-mcp-recipe-server.js"]
   }
   ```

Back up your client config before editing it. Running sessions only pick up the change after a restart
(or an MCP reconnect, e.g. `/mcp` in Claude Code).

Optional environment variables:
- `MOBILE_MCP_RECIPES_DIR` — recipe/guidance store (default `~/.mobile-mcp/recipes`)
- `UPSTREAM_MCP_COMMAND` / `UPSTREAM_MCP_ARGS` — run a different upstream Mobile MCP build

### Learning recipes
Learning is on demand: after an agent completes a workflow in an app, it calls `mobile_recipe_auto_learn`
to save the recorded steps as a `draft` recipe. Later sessions that open that app are told about the recipe
automatically and can replay it with `mobile_recipe_run`. Review a draft with `mobile_recipe_show` before
relying on it.

---

## 6. Upstream Versions Examined
- **Ghost OS**: `https://github.com/ghostwright/ghost-os` — commit `991aa4831295aaff6beef04cc809d0f0b53dc024` (MIT License)
- **Mobile MCP**: `https://github.com/mobile-next/mobile-mcp` — version `1.0.17` (`@mobilenext/mobile-mcp@1.0.17`, Apache-2.0 License)

---

## 7. Remaining Limitations
1. **Live Human Recording**: Manual background input monitoring (like Ghost OS CGEvent tap on macOS) was deferred for Android in this phase to prevent invasive native hooking and device permission scope expansion. Recipes are instead learned/synthesized via agent workflows and saved via `mobile_recipe_save`.
2. **Device Turn Lock Boundary**: The extension respects authorization boundaries. Recipe execution cannot bypass device turn locks, physical unlock PINs, or prompt approval policies configured in client TOML files.
3. **Dynamic View Recycling**: Android `RecyclerView` elements that are fully scrolled out of memory may require explicit scrolling steps in recipes if they are not bound in accessibility tree.
