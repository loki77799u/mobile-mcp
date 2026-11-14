"use strict";

const assert = require("node:assert");
const { insertTextVerified } = require("../src/helpers/text-insertion");
const { compareExactText } = require("../src/utils");
const FakeUpstreamServer = require("./fake-upstream");

async function runTextInsertionTests() {
  console.log("▶ Running Test Suite: Exact Verified Text Insertion");

  const fakeUpstream = new FakeUpstreamServer();
  const mockInvoker = async (toolName, args) => {
    const res = fakeUpstream.dispatchTool(toolName, args);
    return res;
  };

  const device = "test-device-1";

  // Test 1: CompareExactText strictly rejects length-only matches
  const lenMatch1 = "Stand-In v1.2 test";
  const lenMatch2 = "Stand-In v1. 2 tes"; // Exact same character length (18 chars), but different content!
  assert.strictEqual(lenMatch1.length, lenMatch2.length, "Lengths must be equal for test");
  const lenComp = compareExactText(lenMatch1, lenMatch2);
  assert.strictEqual(lenComp.match, false, "Length match alone must be rejected");
  assert.ok(lenComp.diffHint.includes("Divergence at index 12"), "Must pinpoint exact divergence");
  console.log("  ✔ compareExactText correctly rejects same-length mismatch");

  // Test 2: Focus Acquisition & Verified Paste
  // Starting with unfocused EditText
  fakeUpstream.isEditTextFocused = false;
  fakeUpstream.editTextValue = "";

  const testText1 = "Stand-In v1.2 test";
  const insertRes1 = await insertTextVerified(mockInvoker, {
    device,
    text: testText1
  });

  assert.strictEqual(insertRes1.success, true, "Insertion must succeed");
  assert.strictEqual(insertRes1.verified, true, "Insertion must be verified");
  assert.strictEqual(insertRes1.exact_match, true, "Must have exact match");
  assert.strictEqual(fakeUpstream.editTextValue, testText1, "Value in mock EditText must match");
  assert.strictEqual(fakeUpstream.isEditTextFocused, true, "Must acquire focus on target node");
  console.log("  ✔ focus acquired on node and exact text inserted via clipboard paste");

  // Test 3: Spacing bug avoidance
  // Direct typing would corrupt "v1.2" -> "v1. 2" in fakeUpstream.dispatchTool
  // But insertTextVerified uses clipboard paste, completely avoiding the bug!
  assert.strictEqual(fakeUpstream.editTextValue.includes("v1. 2"), false, "Must not introduce stray space in v1.2");
  console.log("  ✔ mobile_type_keys spacing bug prevented by verified clipboard paste");

  // Test 4: Unicode, complex punctuation, multiline, and trailing newlines
  const complexText = `Stand-In: Negotiation Checklist — v1.2
• Ask: 8% raise starting January 1st
• Highlights: "client reports in March", 6 late shifts
• Unicode: Café crème, 日本語, 𝕏, Ñ, — em-dash
• Status: [READY]
`; // includes multiline and trailing newline

  const insertRes2 = await insertTextVerified(mockInvoker, {
    device,
    text: complexText
  });
  assert.strictEqual(insertRes2.success, true);
  assert.strictEqual(insertRes2.verified, true);
  assert.strictEqual(fakeUpstream.editTextValue, complexText);
  console.log("  ✔ Unicode, punctuation, multiline content, and trailing newlines verified exactly");

  // Test 5: Full 7,891-character prompt instructions test
  const longText = "A".repeat(7890) + "\n";
  assert.strictEqual(longText.length, 7891);
  const insertRes3 = await insertTextVerified(mockInvoker, {
    device,
    text: longText
  });
  assert.strictEqual(insertRes3.success, true);
  assert.strictEqual(insertRes3.length, 7891);
  assert.strictEqual(fakeUpstream.editTextValue.length, 7891);
  console.log("  ✔ 7,891-character instruction text verified character-for-character without truncation");

  // Test 6: Mismatch detection & refusal to proceed
  // Simulate UI corruption where app altered one character
  fakeUpstream.dispatchTool = (toolName, args) => {
    if (toolName === "mobile_list_elements_on_screen") {
      return {
        content: [{
          type: "text",
          text: `One element per line: @ref Type text= label= name= value= id= at=x,y size=WxH [focused] [selected] [checked] [disabled]
@e41 EditText text="corrupted_readback_value" at=209,2035 size=712x122 focused`
        }]
      };
    }
    return { content: [{ type: "text", text: "ok" }] };
  };

  const corruptRes = await insertTextVerified(mockInvoker, {
    device,
    text: "expected_clean_value"
  });
  assert.strictEqual(corruptRes.success, false, "Must fail when readback mismatches");
  assert.strictEqual(corruptRes.verified, false);
  assert.ok(corruptRes.error.includes("Text verification mismatch"), "Must report mismatch diagnostic");
  console.log("  ✔ readback mismatch halts execution immediately");

  console.log("✔ Suite 3: Verified text insertion passed all checks\n");
}

module.exports = { runTextInsertionTests };

if (require.main === module) {
  runTextInsertionTests().catch(err => {
    console.error("Suite 3 failed:", err);
    process.exit(1);
  });
}
