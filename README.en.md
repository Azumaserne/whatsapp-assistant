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

### 1. Prerequisites

- [Node.js](https://nodejs.org/) **18.0.0 or higher** (20 / 22 / 24 LTS recommended)
- A **secondary WhatsApp account** to host the assistant
- Your own **LLM API Key**

### 2. Installation & Configuration

```bash
git clone https://github.com/kaka714/whatsapp-assistant.git
cd whatsapp-assistant
npm install
```

Copy `.env.example` to `.env` and fill in your credentials:

```bash
cp .env.example .env
# On Windows CMD: copy .env.example .env
```

Edit `.env` (at minimum, set these 3 variables):

```env
LLM_API_KEY=sk-your-real-api-key
LLM_BASE_URL=https://api.openai.com/v1
LLM_MODEL=gpt-4o-mini
```

### 3. Launch & Link Device

```bash
npm start
# On Windows, you can also double-click start.cmd
```

1. When the QR code appears in the terminal, open your **secondary WhatsApp account** → **Linked Devices** → **Link a Device** and scan it.
2. Once you see `✅ WhatsApp AI 助手已成功上线！`, send a message or forward a chat snippet from your primary phone to get started.
3. Session credentials are cached in `.wwebjs_auth/` so you won't need to re-scan on restart (press `Ctrl + C` for a clean shutdown).

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
├── start.cmd              # Windows launcher with Node.js / .env / dependency checks
├── prompt.txt             # Default assistant System Prompt (hot-reloaded on every turn)
├── .env.example           # Environment configuration template
├── LICENSE                # MIT License
├── README.md              # Documentation (简体中文)
├── README.en.md           # Documentation (English)
├── README.de.md           # Documentation (Deutsch)
├── src/
│   ├── config.js          # Env parsing, legacy DEEPSEEK_API_KEY fallback & whitelist checks
│   ├── chatExport.js      # Pure-Node zlib parser for .txt / .zip WhatsApp chat exports
│   ├── forwardBuffer.js   # Per-sender debounce batcher & /collect state management
│   ├── prompts.js         # Hot-reloaded prompt builder & analysis mode instructions
│   ├── memory.js          # Local memory.json persistence & legacy format migration
│   ├── llm.js             # OpenAI-compatible wrapper, message chunking & error mapping
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
