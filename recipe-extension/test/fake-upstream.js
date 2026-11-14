"use strict";

const EventEmitter = require("node:events");

/**
 * Realistic screen tree fixtures based directly on ChatGPT Android retest observations.
 */
const CHATGPT_SCREEN_TREE_UNFOCUSED = `One element per line: @ref Type text= label= name= value= id= at=x,y size=WxH [focused] [selected] [checked] [disabled]
@e1 LinearLayout id="com.openai.chatgpt:id/action_bar_root" at=0,0 size=1008x2244
@e2 FrameLayout id="android:id/content" at=0,0 size=1008x2244
@e19 TextView text="Worked for 43s" at=41,562 size=276x48
@e20 TextView text="Scored the conversation and framed the business case" at=41,651 size=926x110
@e24 TextView text="STAND-IN SCORECARD" label="STAND-IN SCORECARD" at=41,1042 size=926x82
@e25 TextView text="Result: partly — you made a clear ask and gave evidence, but didn't resolve their question." label="Result: partly — you made a clear ask and gave evidence, but didn't resolve their question." at=41,1144 size=926x132
@e28 TextView text="Soft words: sorry 1, just 1, maybe 1." label="Soft words: sorry 1, just 1, maybe 1." at=41,1795 size=926x66
@e35 TextView text="Stand-In v1.2 test" at=342,205 size=324x62
@e36 View at=31,175 size=122x122
@e37 View label="Navigate up" at=36,180 size=112x112
@e40 View label="Reply to ChatGPT" at=209,2065 size=712x62
@e41 EditText at=209,2035 size=712x122
@e42 View at=87,2035 size=122x122
@e43 View label="Attachment" at=118,2066 size=61x61`;

const CHATGPT_ATTACHMENT_MENU = `One element per line: @ref Type text= label= name= value= id= at=x,y size=WxH [focused] [selected] [checked] [disabled]
@e50 LinearLayout id="com.openai.chatgpt:id/attachment_menu" at=87,1500 size=600x500
@e51 TextView text="Upload file" label="Upload file" at=100,1520 size=400x80
@e52 TextView text="Think harder" label="Think harder" at=100,1620 size=400x80
@e53 TextView text="Search web" label="Search web" at=100,1720 size=400x80`;

const SETTINGS_SCREEN_TREE = `One element per line: @ref Type text= label= name= value= id= at=x,y size=WxH [focused] [selected] [checked] [disabled]
@e1 LinearLayout id="com.android.settings:id/settings_root" at=0,0 size=1008x2244
@e2 TextView text="Network & internet" label="Network & internet" at=40,200 size=800x100
@e3 TextView text="Connected devices" label="Connected devices" at=40,320 size=800x100
@e4 TextView text="Apps" label="Apps" at=40,440 size=800x100`;

class FakeUpstreamServer extends EventEmitter {
  constructor() {
    super();
    this.clipboardText = "";
    this.editTextValue = "";
    this.isEditTextFocused = false;
    this.currentForegroundPackage = "com.openai.chatgpt";
    this.thinkingState = "off";
    this.isAttachmentMenuOpen = false;
    this.failSubmission = false;
    this.simulateTimeout = false;
  }

  handleMessage(msg) {
    if (!msg || typeof msg !== "object") return;
    const { id, method, params } = msg;

    if (method === "initialize") {
      this.emit("response", {
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: "2024-11-05",
          capabilities: { tools: {} },
          serverInfo: { name: "mobile-mcp", version: "1.0.17" },
          instructions: "Drive a real or simulated iOS/Android device. Start with mobile_list_available_devices."
        }
      });
      return;
    }

    if (method === "tools/list") {
      this.emit("response", {
        jsonrpc: "2.0",
        id,
        result: {
          tools: [
            {
              name: "mobile_list_available_devices",
              description: "List all available local devices",
              inputSchema: { type: "object", properties: {} }
            },
            {
              name: "mobile_get_foreground_app",
              description: "Get foreground app name, package, and activity",
              inputSchema: { type: "object", properties: { device: { type: "string" } }, required: ["device"] }
            },
            {
              name: "mobile_launch_app",
              description: "Launch an app by package name",
              inputSchema: { type: "object", properties: { device: { type: "string" }, packageName: { type: "string" } }, required: ["device", "packageName"] }
            },
            {
              name: "mobile_list_elements_on_screen",
              description: "List elements with ref, coordinates, display text, a11y label",
              inputSchema: { type: "object", properties: { device: { type: "string" }, format: { type: "string" } }, required: ["device"] }
            },
            {
              name: "mobile_click_on_screen_at_coordinates",
              description: "Click by x,y coordinates",
              inputSchema: { type: "object", properties: { device: { type: "string" }, x: { type: "number" }, y: { type: "number" } }, required: ["device"] }
            },
            {
              name: "mobile_press_button",
              description: "Press hardware/navigation button or keyevent",
              inputSchema: { type: "object", properties: { device: { type: "string" }, button: { type: "string" } }, required: ["device", "button"] }
            },
            {
              name: "mobile_clipboard",
              description: "Read or write clipboard",
              inputSchema: { type: "object", properties: { device: { type: "string" }, text: { type: "string" } }, required: ["device"] }
            },
            {
              name: "mobile_type_keys",
              description: "Type text using keyboard",
              inputSchema: { type: "object", properties: { device: { type: "string" }, text: { type: "string" } }, required: ["device", "text"] }
            }
          ]
        }
      });
      return;
    }

    if (method === "tools/call") {
      const toolName = params.name;
      const args = params.arguments || {};
      const response = this.dispatchTool(toolName, args);

      if (this.simulateTimeout) {
        // Do not respond
        return;
      }

      this.emit("response", {
        jsonrpc: "2.0",
        id,
        result: response
      });
      return;
    }

    if (method === "ping") {
      this.emit("response", { jsonrpc: "2.0", id, result: {} });
      return;
    }

    // Default error
    this.emit("response", {
      jsonrpc: "2.0",
      id,
      error: { code: -32601, message: `Method not found: ${method}` }
    });
  }

  dispatchTool(name, args) {
    switch (name) {
      case "mobile_list_available_devices":
        return {
          content: [{ type: "text", text: JSON.stringify({ devices: [{ id: "test-device-123", name: "Pixel 8 Pro", platform: "android" }] }) }]
        };

      case "mobile_get_foreground_app":
        return {
          content: [{ type: "text", text: JSON.stringify({ package: this.currentForegroundPackage, activity: ".MainActivity" }) }]
        };

      case "mobile_launch_app":
        this.currentForegroundPackage = args.packageName;
        return {
          content: [{ type: "text", text: `App ${args.packageName} launched.` }]
        };

      case "mobile_clipboard":
        if (args.text !== undefined) {
          this.clipboardText = args.text;
          return { content: [{ type: "text", text: "Clipboard set" }] };
        }
        return { content: [{ type: "text", text: this.clipboardText }] };

      case "mobile_click_on_screen_at_coordinates": {
        const x = args.x;
        const y = args.y;

        // Click on EditText (approx at=209,2035 size=712x122) -> acquires focus
        if (x >= 200 && x <= 920 && y >= 2000 && y <= 2160) {
          this.isEditTextFocused = true;
          this.isAttachmentMenuOpen = false;
          return { content: [{ type: "text", text: `Clicked at ${x},${y} (EditText focused)` }] };
        }

        // Click on Attachment button (at=87,2035 size=122x122)
        if (x >= 80 && x <= 200 && y >= 2000 && y <= 2160) {
          this.isAttachmentMenuOpen = true;
          return { content: [{ type: "text", text: `Clicked at ${x},${y} (Attachment menu opened)` }] };
        }

        // Click on Think harder menu item (at=100,1620 size=400x80)
        if (this.isAttachmentMenuOpen && x >= 100 && x <= 500 && y >= 1600 && y <= 1700) {
          this.thinkingState = this.thinkingState === "on" ? "off" : "on";
          this.isAttachmentMenuOpen = false;
          return { content: [{ type: "text", text: `Toggled Think harder: now ${this.thinkingState}` }] };
        }

        return { content: [{ type: "text", text: `Clicked at ${x},${y}` }] };
      }

      case "mobile_press_button": {
        if (args.button === "PASTE") {
          if (this.isEditTextFocused) {
            this.editTextValue = this.clipboardText;
            return { content: [{ type: "text", text: `Pasted ${this.clipboardText.length} characters.` }] };
          } else {
            return { content: [{ type: "text", text: "Paste ignored: no field focused" }] };
          }
        }
        if (args.button === "BACK") {
          this.isAttachmentMenuOpen = false;
          return { content: [{ type: "text", text: "Pressed BACK" }] };
        }
        return { content: [{ type: "text", text: `Pressed ${args.button}` }] };
      }

      case "mobile_type_keys": {
        // Intentionally replicate the bug observed in REPORT.md where mobile_type_keys inserted stray space in "v1.2"
        let text = args.text;
        if (text.includes("v1.2")) {
          text = text.replace("v1.2", "v1. 2");
        }
        this.editTextValue = text;
        return { content: [{ type: "text", text: `Typed: ${text}` }] };
      }

      case "mobile_list_elements_on_screen": {
        if (this.currentForegroundPackage === "com.android.settings") {
          return { content: [{ type: "text", text: SETTINGS_SCREEN_TREE }] };
        }

        if (this.isAttachmentMenuOpen) {
          return { content: [{ type: "text", text: CHATGPT_ATTACHMENT_MENU }] };
        }

        // Build dynamic ChatGPT screen tree based on state
        const lines = [
          'One element per line: @ref Type text= label= name= value= id= at=x,y size=WxH [focused] [selected] [checked] [disabled]',
          '@e1 LinearLayout id="com.openai.chatgpt:id/action_bar_root" at=0,0 size=1008x2244',
          '@e2 FrameLayout id="android:id/content" at=0,0 size=1008x2244',
          '@e35 TextView text="Stand-In v1.2 test" at=342,205 size=324x62',
          '@e37 View label="Navigate up" at=36,180 size=112x112'
        ];

        if (this.thinkingState === "on") {
          lines.push('@e38 View label="Think harder" text="Think harder" at=209,1980 size=150x40');
        }

        lines.push('@e40 View label="Reply to ChatGPT" at=209,2065 size=712x62');

        // Render EditText with its focus state and current text
        const focusFlag = this.isEditTextFocused ? "focused" : "";
        const textAttr = this.editTextValue ? `text=${JSON.stringify(this.editTextValue)}` : "";
        lines.push(`@e41 EditText ${textAttr} at=209,2035 size=712x122 ${focusFlag}`.trim());

        lines.push('@e42 View at=87,2035 size=122x122');
        lines.push('@e43 View label="Attachment" at=118,2066 size=61x61');

        return { content: [{ type: "text", text: lines.join("\n") }] };
      }

      default:
        return {
          content: [{ type: "text", text: `Executed ${name}` }]
        };
    }
  }
}

module.exports = FakeUpstreamServer;
