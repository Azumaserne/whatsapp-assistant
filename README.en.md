<div align="center">

# WhatsApp AI Assistant

**No screenshots needed! Forward WhatsApp chat history directly to analyze conversations with AI**

[![Node.js](https://img.shields.io/badge/Node.js-18%2B-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![whatsapp-web.js](https://img.shields.io/badge/WhatsApp-whatsapp--web.js-25D366?logo=whatsapp&logoColor=white)](https://wwebjs.dev/)
[![OpenAI Compatible](https://img.shields.io/badge/API-OpenAI%20Compatible-412991?logo=openai&logoColor=white)](https://platform.openai.com/)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

*Designed & Authored by **[@Azumaserne](https://github.com/kaka714/whatsapp-assistant)***

<p>🌐 <a href="README.md">简体中文</a> | <strong>English</strong> | <a href="README.de.md">Deutsch</a></p>

</div>

---

> [!CAUTION]
> **Important Notice & Disclaimer (Please Read Before Use)**
>
> 1. **Bring Your Own API (BYO API)**: This project only provides the WhatsApp bridge and chat-analysis orchestration. **No free model credits or hosted proxy are included.** You must supply your own API key from OpenAI, DeepSeek, OpenRouter, Gemini, Kimi, or a local Ollama endpoint.
> 2. **No Liability for Account Bans**: This project relies on the unofficial [`whatsapp-web.js`](https://github.com/pedroslopez/whatsapp-web.js) library. Automated behavior may violate WhatsApp's Terms of Service and **carries the risk of rate-limiting or account bans**. **Always run it with a dedicated secondary WhatsApp account and avoid high-frequency messaging. The author assumes zero liability for any banned accounts, data loss, or API costs.**

---

## 💡 Why This Project? (Stop Taking Screenshots for AI)

Traditionally, getting ChatGPT, Claude, or DeepSeek to analyze a chat thread (e.g., *"What do they actually mean?"*, *"How should I reply tactfully?"*, *"Summarize the action items"*) is tedious:

| Comparison | Traditional Screenshot-to-AI Workflow | WhatsApp AI Assistant |
| :--- | :--- | :--- |
| **Workflow** | Take 5–10 overlapping screenshots → switch apps → upload images → wait for OCR | **Multi-select messages inside WhatsApp → Forward directly to the assistant** (or send an exported `.txt`/`.zip`) |
| **Text Fidelity** | Screenshots suffer from compression, clipped bubbles, and OCR typos | **Reads raw text and timestamps directly** with zero OCR loss |
| **Batch Forwarding** | Copying & pasting message by message loses order | **Built-in debounce batcher**: forwarding N messages at once triggers only **1** LLM request |
| **Cross-Chat Gathering** | Constantly switching back and forth between chats | Send `/collect` to gather forwards across multiple chats, then run `/analyze` once |
| **Follow-Ups** | Switching apps breaks your conversation flow | Ask follow-up questions in the same thread (supports WhatsApp quote-replies) to refine tone or drafts |

---

## ✨ Key Features

- **📥 Multi-Select Forward Batching**: WhatsApp emits multiple forwarded messages as rapid consecutive events. A per-sender debounce buffer merges them into a single chronological transcript before calling the LLM. If you send a question right after forwarding (e.g., *"Are they upset?"*), it **cancels the wait timer immediately and analyzes the transcript together with your question**.
- **📦 Native WhatsApp Chat Export (`.txt` / `.zip`)**: For very long conversations, use WhatsApp's **Export Chat (Without Media)** and send the `.txt` or `.zip` archive directly. A zero-dependency pure-Node `zlib` parser extracts the transcript (`_chat.txt` prioritized) and trims oversized logs to the most recent tail.
- **🎭 5 Built-In Analysis Modes (`/mode`)**:
  - `general` (Comprehensive): Core summary + tone/subtext + reply suggestions
  - `summary` (Concise Summary): Timeline, key conclusions, and action items
  - `emotion` (Tone & Subtext): Sentiment shifts, hidden concerns, and intent signals
  - `reply` (Tactful Replies): 3 copy-ready reply drafts in different tones
  - `translate` (Translation & Nuance): Accurate translation plus slang/tone explanation
- **🔌 Any OpenAI-Compatible API**: Configure `LLM_BASE_URL`, `LLM_API_KEY`, and `LLM_MODEL` to connect OpenAI, DeepSeek, OpenRouter, Gemini (OpenAI-compatible endpoint), Moonshot/Kimi, Zhipu GLM, OneAPI/NewAPI, or local Ollama (also backward-compatible with `DEEPSEEK_API_KEY`).
- **⚠️ Non-Multimodal Model Detection & Warnings**: Automatically detects whether the selected model supports vision (`LLM_MULTIMODAL=auto|true|false`). When a **non-multimodal (text-only) model** (e.g., `deepseek-chat`, `deepseek-reasoner`, `moonshot-v1-8k`, `qwen2.5:7b`) is selected, the assistant proactively sends a **warning message in WhatsApp** and logs a notice in the terminal. Multimodal models (e.g., `gpt-4o-mini`, `gemini-2.5-flash`, `claude-3.5-sonnet`) can also inspect images embedded in forwarded chats.
- **🧠 Persistent Memory & Hot-Reloaded Prompt**: Conversation history is stored locally in `memory.json` (git-ignored) and resettable via `/reset`. Edit `prompt.txt` anytime—changes take effect on the very next message without restarting.
- **🛡️ Privacy & Anti-Ban Safeguards**: Optional `ALLOWED_NUMBERS` whitelist (supports standard phone numbers and WhatsApp `@lid` contacts), DM-only filtering (ignores groups and status broadcasts), typing indicators with randomized delays, and self-chat loop protection.

---

## 🚀 Quick Start

### Option 1: One-Click Windows PowerShell Launcher (Recommended)

1. Double-click **`start.cmd`** (or run `pwsh .\whatsapp-assistant.ps1` / `.\whatsapp-assistant.ps1` in PowerShell).
2. Inside the **same command window**, the wizard automatically checks Node.js & dependencies and walks you through all required inputs (API provider preset, model name, API key, forwarding trigger mode, whitelist, self-chat option, and detected browser path), displaying an immediate warning if a non-multimodal model is selected.
3. Once configured, the **WhatsApp login QR code renders directly in the same command window**—scan it with your secondary WhatsApp account via **Linked Devices → Link a Device**.
4. All recorded information and daily analysis logs are automatically saved to your Desktop under `<Desktop>\WhatsApp-Assistant-Data\`:
   - `config.env` — saved runtime configuration
   - `setup-info.txt` — human-readable summary of all entered settings
   - `memory.json` — per-contact conversation history and active modes
   - `records\YYYY-MM-DD.md` — daily Markdown archives of analyzed chats

> Tip: On subsequent runs, press Enter to launch directly with your saved settings, or pick `[2]` to reconfigure. Press `Ctrl + C` for a clean exit.

### Option 2: Manual CLI Setup (macOS / Linux / Servers)

1. Make sure [Node.js](https://nodejs.org/) **18.0.0 or higher** is installed, and prepare a **secondary WhatsApp account** plus your own **LLM API Key**.
2. Clone the repository and install dependencies:

```bash
git clone https://github.com/kaka714/whatsapp-assistant.git
cd whatsapp-assistant
npm install
```

3. Copy `.env.example` to `.env` and fill in at least these 3 credentials:

```bash
cp .env.example .env
```

```env
LLM_API_KEY=sk-your-real-api-key
LLM_BASE_URL=https://api.openai.com/v1
LLM_MODEL=gpt-4o-mini
```

4. Launch and scan the QR code:

```bash
npm start
```

When the QR code appears in the terminal, scan it from your secondary WhatsApp account under **Linked Devices → Link a Device**. Once `✅ WhatsApp AI 助手已成功上线！` appears, you are ready to go. Session state is cached in `.wwebjs_auth/`.

---

## 🔌 Supported API Providers (BYO API)

| Provider | `LLM_BASE_URL` | Example `LLM_MODEL` |
| :--- | :--- | :--- |
| **OpenAI** | `https://api.openai.com/v1` | `gpt-4o-mini` / `gpt-4.1-mini` |
| **DeepSeek** | `https://api.deepseek.com` | `deepseek-chat` / `deepseek-reasoner` |
| **OpenRouter** | `https://openrouter.ai/api/v1` | `openai/gpt-4o-mini` / `anthropic/claude-3.5-sonnet` |
| **Google Gemini (OpenAI-compat)** | `https://generativelanguage.googleapis.com/v1beta/openai/` | `gemini-2.5-flash` |
| **Moonshot / Kimi** | `https://api.moonshot.cn/v1` | `moonshot-v1-8k` |
| **Zhipu GLM** | `https://open.bigmodel.cn/api/paas/v4` | `glm-4-flash` |
| **Local Ollama** | `http://localhost:11434/v1` | `qwen2.5:7b` |

---

## 💬 Usage & WhatsApp Commands

### Everyday Workflows

1. **Direct Forwarding (Most Common)**:
   - Long-press and multi-select messages in any WhatsApp chat → **Forward** them to the assistant.
   - **With a specific question**: Send your question right after forwarding (e.g., *"How do I decline politely?"*) to combine and analyze immediately.
   - **Hands-free**: Simply wait ~6 seconds (`FORWARD_DEBOUNCE_MS` in `.env`) and the assistant will automatically analyze the batch using your active mode.
2. **Exported Chat Files**:
   - In any WhatsApp chat menu, tap **More → Export Chat → Without Media** and send the `.txt` or `.zip` file to the assistant (optionally add a question in the file caption).
3. **Interactive Follow-Ups**:
   - Continue asking questions naturally, or use WhatsApp's native **Reply / Quote** feature on a specific message to focus the assistant.

### Command Reference

| Command | Description |
| :--- | :--- |
| `/help` | Show usage guide, active configuration, and command list |
| `/analyze [question]` | Analyze all buffered forwarded messages immediately (with optional question) |
| `/collect` | Toggle **manual collection mode** (ideal for gathering forwards across multiple chats) |
| `/buffer` | Show buffered message count and recent previews |
| `/clear` | Clear pending forwarded messages without resetting conversation memory |
| `/mode [name]` | List or switch analysis modes (`general` / `summary` / `emotion` / `reply` / `translate`) |
| `/reset` | Clear conversation history & forward buffer, and hot-reload `prompt.txt` |

---

## 📁 Project Structure

```text
whatsapp-assistant/
├── index.js               # Entry point: WhatsApp client setup, events, and message adapter
├── whatsapp-assistant.ps1 # One-click PowerShell wizard, QR console & Desktop saving
├── start.cmd              # Double-click Windows launcher (auto-invokes pwsh / powershell)
├── prompt.txt             # Default assistant System Prompt (hot-reloaded on every turn)
├── .env.example           # Environment configuration template
├── LICENSE                # MIT License
├── README.md              # Documentation (简体中文)
├── README.en.md           # Documentation (English)
├── README.de.md           # Documentation (Deutsch)
├── src/
│   ├── config.js          # Env parsing, multimodal detection, legacy fallback & whitelist
│   ├── chatExport.js      # Pure-Node zlib parser for .txt / .zip WhatsApp chat exports
│   ├── forwardBuffer.js   # Per-sender debounce batcher & /collect state management
│   ├── prompts.js         # Hot-reloaded prompts, non-multimodal warnings & mode instructions
│   ├── memory.js          # Local memory.json persistence & legacy format migration
│   ├── llm.js             # OpenAI-compatible wrapper, message chunking & error mapping
│   ├── recorder.js        # Desktop daily Markdown analysis archive writer
│   └── handler.js         # Message router, per-sender serial queue & self-chat loop guard
└── test/
    └── assistant.test.js  # Built-in Node test suite (batching, ZIP parsing, commands, guards)
```

---

## 🧪 Testing & Verification

The project includes an offline unit test suite powered by Node's built-in `node:test` runner (no browser or live WhatsApp session required):

```bash
npm run check   # Syntax check all source files
npm test        # Run automated unit tests
```

---

## 📄 License

Released under the **[MIT License](LICENSE)** — Copyright © 2026 **[Azumaserne](https://github.com/kaka714/whatsapp-assistant)**.
