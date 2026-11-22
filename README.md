<div align="center">

# WhatsApp AI Assistant

**无需截图！直接把聊天记录转发给它，就能立刻帮你分析的 WhatsApp 智能助手**

[![Node.js](https://img.shields.io/badge/Node.js-18%2B-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![whatsapp-web.js](https://img.shields.io/badge/WhatsApp-whatsapp--web.js-25D366?logo=whatsapp&logoColor=white)](https://wwebjs.dev/)
[![OpenAI Compatible](https://img.shields.io/badge/API-OpenAI%20Compatible-412991?logo=openai&logoColor=white)](https://platform.openai.com/)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

*Designed & Authored by **[@Azumaserne](https://github.com/kaka714/whatsapp-assistant)***

</div>

---

> [!CAUTION]
> **使用前必读｜免责与风控声明**
>
> 1. **必须自备 API（BYO API）**：本项目仅提供 WhatsApp 桥接与聊天分析编排能力，**不包含任何免费模型额度**，请自行准备 OpenAI、DeepSeek、OpenRouter、Gemini、Kimi 或本地 Ollama 等接口密钥。
> 2. **封号不负责**：本项目基于非官方逆向协议库 [`whatsapp-web.js`](https://github.com/pedroslopez/whatsapp-web.js) 运行，违反 WhatsApp 服务条款的自动化行为**存在账号限流或封禁风险**。**强烈建议使用独立小号挂载运行，切勿在主力号上高频群发；任何因使用本项目导致的封号、数据丢失或费用产生，作者均不承担责任。**

---

## 💡 为什么做这个项目？（告别传统 AI 截图上传）

平时想让 ChatGPT / Claude / DeepSeek 帮忙分析一段微信或 WhatsApp 对话（比如“对方到底什么意思”“怎么高情商回复”“帮我总结刚才群里敲定了什么”），传统做法极其繁琐：

| 对比维度 | 传统 AI 使用方式 | 本项目（WhatsApp AI 助手） |
| :--- | :--- | :--- |
| **操作路径** | 连续截 5~10 张长图 → 切出 WhatsApp → 打开 AI App → 逐张上传并等 OCR 识别 | **直接在 WhatsApp 内长按多选消息 → 转发给助手**（或导出 `.txt/.zip` 直接发送） |
| **文字还原度** | 截图受分辨率、气泡遮挡、折叠文本影响，常漏字/错行 | **直接获取纯文本与时间戳**，无 OCR 误差，长对话也能完整把握 |
| **多条转发体验** | 手动拼接文本容易漏段 | **内置防抖聚合器**：多选转发连发 N 条只合并调用 **1 次** 大模型 |
| **跨对话收集** | 反复切窗口复制粘贴 | 发送 `/collect` 开启收集模式，分批转发多段记录后再统一 `/analyze` |
| **追问与改写** | 换个 App 脱离原始对话节奏 | 原地继续发文字追问（支持引用回复），随时调整回复语气 |

---

## ✨ 核心功能

- **📥 原生多选转发批量聚合**：WhatsApp 一次性转发多条消息时会拆分成连续事件到达，助手通过 Per-Sender 防抖窗口自动聚合成一条完整时间线再交由 AI 分析；如果在等待窗口内你紧接着发了一句提问（如“他是不是生气了？”），会**立即取消等待并合并提问一次性分析**。
- **📦 原生支持 WhatsApp 导出聊天文件（`.txt` / `.zip`）**：长对话懒得一条条转发？直接在原聊天右上角点击「更多 → 导出聊天记录（不含媒体）」，把 `.txt` 或 `.zip` 压缩包发给助手即可自动解压读取（内置纯 Node `zlib` 解析器，零额外依赖，超长历史自动保留最新尾部对话）。
- **🎭 5 种内置分析模式（`/mode`）**：
  - `general`（综合分析）：核心脉络 + 情绪与潜台词 + 回复参考
  - `summary`（精炼摘要）：时间线、结论与待办清单
  - `emotion`（情绪与潜台词）：语气转折、真实诉求与博弈信号
  - `reply`（高情商回复）：提供 3 种不同风格、可直接复制发送的回复话术
  - `translate`（翻译与双语解读）：精准翻译外语对话并解释俚语/语气
- **🔌 通用 OpenAI 兼容接口**：只需配置 `LLM_BASE_URL`、`LLM_API_KEY`、`LLM_MODEL`，即可接入 OpenAI、DeepSeek、OpenRouter、Gemini（OpenAI 兼容端点）、Moonshot/Kimi、智谱 GLM、OneAPI/NewAPI 或本地 Ollama（同时兼容旧版 `DEEPSEEK_API_KEY`）。
- **🧠 持久化上下文 + 人设热更新**：对话记录保存在本地 `memory.json`（已忽略上传），支持 `/reset` 重置；随时编辑 `prompt.txt` 即可在下一条消息热生效。
- **🛡️ 安全与防风控细节**：支持 `ALLOWED_NUMBERS` 联系人白名单（兼容普通手机号及 WhatsApp `@lid` 隐匿 ID）、默认仅响应私聊（自动过滤群聊与状态广播）、模拟“正在输入...”与随机延迟，以及可选的自聊窗口防死循环前缀保护。

---

## 🚀 快速开始

### 1. 环境准备

- [Node.js](https://nodejs.org/) **18.0.0 或更高版本**（推荐 20/22/24 LTS）
- 一个用于挂载机器人的 **WhatsApp 小号**
- 你自己的 **大模型 API Key**

### 2. 安装依赖与配置

```bash
git clone https://github.com/kaka714/whatsapp-assistant.git
cd whatsapp-assistant
npm install
```

复制配置模板为 `.env` 并填入你的 API 信息：

```bash
cp .env.example .env
# Windows CMD 可用：copy .env.example .env
```

编辑 `.env`（至少填写前 3 项）：

```env
LLM_API_KEY=sk-你的真实密钥
LLM_BASE_URL=https://api.openai.com/v1
LLM_MODEL=gpt-4o-mini
```

### 3. 启动与扫码登录

```bash
npm start
# Windows 也可直接双击 start.cmd
```

1. 终端显示二维码后，打开作为机器人的 **WhatsApp 小号** → **已连接的设备 (Linked Devices)** → **连接设备** → 扫码。
2. 看到 `✅ WhatsApp AI 助手已成功上线！` 后，用你的主号给这个小号发一条消息或直接转发一段聊天记录即可开始使用。
3. 登录态缓存在 `.wwebjs_auth/` 目录，下次重启无需重复扫码（`Ctrl + C` 可安全退出）。

---

## 🔌 主流 API 配置参考（自备 API）

| 服务商 | `LLM_BASE_URL` | `LLM_MODEL` 示例 |
| :--- | :--- | :--- |
| **OpenAI** | `https://api.openai.com/v1` | `gpt-4o-mini` / `gpt-4.1-mini` |
| **DeepSeek** | `https://api.deepseek.com` | `deepseek-chat` / `deepseek-reasoner` |
| **OpenRouter** | `https://openrouter.ai/api/v1` | `openai/gpt-4o-mini` / `anthropic/claude-3.5-sonnet` |
| **Google Gemini (OpenAI 兼容)** | `https://generativelanguage.googleapis.com/v1beta/openai/` | `gemini-2.5-flash` |
| **Moonshot / Kimi** | `https://api.moonshot.cn/v1` | `moonshot-v1-8k` |
| **智谱 GLM** | `https://open.bigmodel.cn/api/paas/v4` | `glm-4-flash` |
| **本地 Ollama** | `http://localhost:11434/v1` | `qwen2.5:7b` |

---

## 💬 WhatsApp 内置用法与指令

### 日常使用方式

1. **直接转发分析（最常用）**：
   - 在任何 WhatsApp 私聊或群聊里长按多选消息 → 点击**转发**给助手。
   - **想带具体问题**：转发完紧接着发一句（如“怎么委婉拒绝又不伤和气？”），助手会立即把刚刚转发的记录和你的问题合并分析。
   - **懒得打字**：转发完停手等待约 6 秒（可在 `.env` 修改 `FORWARD_DEBOUNCE_MS`），助手会自动按当前模式输出分析报告。
2. **导出文件深度分析**：
   - 在任意聊天右上角选择「导出聊天记录 → 不含媒体」，将生成的 `.txt` 或 `.zip` 直接发给助手，可顺便在文件说明里附带问题。
3. **继续追问**：
   - 收到分析后可直接回复追问，或对特定消息使用 WhatsApp 原生「引用回复」来让助手聚焦某一句。

### 指令一览

| 指令 | 作用 |
| :--- | :--- |
| `/help` | 查看使用指南、当前配置与指令列表 |
| `/analyze [问题]` | 立即分析当前暂存区里的所有转发记录（可附带问题） |
| `/collect` | 开启/关闭**手动收集模式**（适合分多次、从不同聊天转发多段记录） |
| `/buffer` | 查看当前已暂存的转发条数与最近预览 |
| `/clear` | 清空尚未分析的转发暂存区 |
| `/mode [名称]` | 查看或切换分析模式（`general` / `summary` / `emotion` / `reply` / `translate`） |
| `/reset` | 清空当前联系人的历史记忆、暂存区，并热重载 `prompt.txt` |

---

## 📁 项目结构

```text
whatsapp-assistant/
├── index.js               # 程序入口：WhatsApp 客户端连接、状态事件与消息适配
├── start.cmd              # Windows 一键启动脚本（含 Node / .env / 依赖检查）
├── prompt.txt             # 默认分析助手 System Prompt（支持热更新）
├── .env.example           # 环境变量配置模板
├── LICENSE                # MIT 开源协议
├── src/
│   ├── config.js          # 环境变量解析、旧版 DEEPSEEK_API_KEY 兼容与白名单校验
│   ├── chatExport.js      # 纯 Node zlib 实现的 .txt / .zip 导出聊天记录解析与尾部截断
│   ├── forwardBuffer.js   # Per-sender 转发消息防抖聚合器与 /collect 收集状态管理
│   ├── prompts.js         # prompt.txt 热加载、分析模式切换与提示词拼装
│   ├── memory.js          # 本地 memory.json 持久化与旧版记忆格式自动迁移
│   ├── llm.js             # OpenAI 兼容接口封装、长消息智能分段与常见错误提示
│   └── handler.js         # 核心消息调度、串行队列、防自聊死循环与指令路由
└── test/
    └── assistant.test.js  # Node 原生测试套件（覆盖转发聚合、ZIP 解析、指令与安全边界）
```

---

## 🧪 开发与自检

项目内置基于 Node 原生 `node:test` 的单元测试（无需启动浏览器或连接真实 WhatsApp）：

```bash
npm run check   # 语法检查
npm test        # 运行自动化测试
```

---

## 📄 开源协议

本项目基于 **[MIT License](LICENSE)** 开源，Copyright © 2026 **[Azumaserne](https://github.com/kaka714/whatsapp-assistant)**。
