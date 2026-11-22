const fs = require('fs');

const DEFAULT_SYSTEM_PROMPT = [
    '你是一个接入 WhatsApp 的智能助手，擅长直接分析用户转发给你的 WhatsApp 聊天记录和导出的聊天文件（.txt / .zip），无需用户截图。',
    '请用适合手机阅读的清晰结构回答，包含核心脉络/结论、关键信息/情绪与潜台词、建议与回复参考。',
    '如果用户附带了具体问题，优先精准回答该问题；不要编造未在聊天记录中出现的事实。'
].join('\n');

const ANALYSIS_MODES = {
    general: {
        label: '综合分析',
        description: '脉络总结 + 情绪潜台词 + 回复建议',
        instruction: '【当前分析模式：综合分析】请均衡输出：核心脉络/结论、关键信息与情绪潜台词、可执行建议或回复参考。'
    },
    summary: {
        label: '精炼摘要',
        description: '快速提炼时间线、结论与待办事项',
        instruction: '【当前分析模式：精炼摘要】重点提炼核心结论、关键时间节点、分工/承诺与待办清单，保持极简干练。'
    },
    emotion: {
        label: '情绪与潜台词',
        description: '拆解态度变化、真实意图与沟通风险',
        instruction: '【当前分析模式：情绪与潜台词】重点分析双方情绪温度、语气转折、隐藏顾虑、真实诉求与关系博弈信号。'
    },
    reply: {
        label: '高情商回复',
        description: '直接给出多风格可复制回复话术',
        instruction: '【当前分析模式：高情商回复】极简概括背景后，重点提供 3 种不同风格（如：温和得体、简洁直接、幽默/留余地）的可直接复制回复草稿及适用场景。'
    },
    translate: {
        label: '翻译与双语解读',
        description: '精准翻译外语对话并解释地道语气',
        instruction: '【当前分析模式：翻译与双语解读】逐段准确翻译外语对话（若原文为外语则译为中文，反之亦然），标注俚语/缩写/语气词的真实语境，并简要总结核心意思。'
    }
};

const MODE_NAMES = Object.keys(ANALYSIS_MODES);

/**
 * Hot-read base system prompt from prompt.txt with safe fallback.
 * @param {string} promptFile
 * @returns {string}
 */
function getBaseSystemPrompt(promptFile) {
    if (promptFile && fs.existsSync(promptFile)) {
        try {
            const content = fs.readFileSync(promptFile, 'utf-8').trim();
            if (content) return content;
        } catch {
            // Fall back to built-in default if prompt file cannot be read
        }
    }
    return DEFAULT_SYSTEM_PROMPT;
}

/**
 * Build full system prompt combining hot-reloaded prompt.txt and active mode instruction.
 * @param {string} promptFile
 * @param {string} [mode]
 * @returns {string}
 */
function buildSystemPrompt(promptFile, mode = 'general') {
    const base = getBaseSystemPrompt(promptFile);
    const activeMode = ANALYSIS_MODES[mode] || ANALYSIS_MODES.general;
    return `${base}\n\n${activeMode.instruction}`;
}

/**
 * Build user prompt for analyzing directly forwarded WhatsApp messages.
 * @param {string} transcript
 * @param {string} [userQuestion]
 * @param {string} [mode]
 * @returns {string}
 */
function buildForwardedAnalysisPrompt(transcript, userQuestion = '', mode = 'general') {
    const activeMode = ANALYSIS_MODES[mode] || ANALYSIS_MODES.general;
    const trimmedQuestion = String(userQuestion || '').trim();

    const parts = [
        transcript,
        `分析模式：${activeMode.label}（${activeMode.description}）`
    ];

    if (trimmedQuestion) {
        parts.push(`用户附带的问题/要求：${trimmedQuestion}`);
    } else {
        parts.push('用户未附带额外问题，请直接按当前分析模式对上述转发记录给出清晰、实用的解读与建议。');
    }

    return parts.join('\n\n');
}

/**
 * Build user prompt for analyzing a parsed WhatsApp Export Chat (.txt / .zip) document.
 * @param {{ filename: string, entryName?: string|null, text: string, totalChars: number, keptChars: number, truncated: boolean }} exportResult
 * @param {string} [userQuestion]
 * @param {string} [mode]
 * @returns {string}
 */
function buildExportedChatPrompt(exportResult, userQuestion = '', mode = 'general') {
    const activeMode = ANALYSIS_MODES[mode] || ANALYSIS_MODES.general;
    const trimmedQuestion = String(userQuestion || '').trim();

    const sourceLabel = exportResult.entryName
        ? `${exportResult.filename} (${exportResult.entryName})`
        : exportResult.filename;

    const headerLines = [
        `[以下是用户上传的 WhatsApp 导出聊天记录文件：${sourceLabel}]`,
        exportResult.truncated
            ? `注：原文件共 ${exportResult.totalChars} 字符，超出单次上下文上限，以下保留了最新 ${exportResult.keptChars} 字符的对话内容。`
            : `注：共 ${exportResult.totalChars} 字符（完整保留）。`
    ];

    const parts = [
        headerLines.join('\n'),
        `--- 聊天记录正文开始 ---\n${exportResult.text}\n--- 聊天记录正文结束 ---`,
        `分析模式：${activeMode.label}（${activeMode.description}）`
    ];

    if (trimmedQuestion) {
        parts.push(`用户附带的问题/要求：${trimmedQuestion}`);
    } else {
        parts.push('用户未附带额外问题，请直接按当前分析模式对上述导出聊天记录给出结构化分析与建议。');
    }

    return parts.join('\n\n');
}

/**
 * Build user-facing WhatsApp help message.
 * @param {{ forwardAutoAnalyze: boolean, forwardDebounceMs: number, model: string }} config
 * @param {string} [currentMode]
 * @returns {string}
 */
function buildHelpText(config, currentMode = 'general') {
    const modeInfo = ANALYSIS_MODES[currentMode] || ANALYSIS_MODES.general;
    const forwardBehavior = config.forwardAutoAnalyze
        ? `自动聚合分析（转发后约 ${Math.round(config.forwardDebounceMs / 1000)} 秒自动开始；期间发送提问则立即合并分析）`
        : '手动触发分析（转发后先暂存，发送问题或 /analyze 后开始分析）';

    const modeLines = MODE_NAMES.map((name) => {
        const item = ANALYSIS_MODES[name];
        const marker = name === (ANALYSIS_MODES[currentMode] ? currentMode : 'general') ? '（当前）' : '';
        return `• ${name}${marker}：${item.label} - ${item.description}`;
    }).join('\n');

    return [
        '*WhatsApp AI 聊天记录分析助手*',
        '无需截图！直接把聊天记录转过来就能分析。',
        '',
        '*两种核心用法：*',
        '1. *直接转发聊天记录*：在任意聊天里长按多选消息 → 转发给本助手，再顺手发一句问题（如“对方什么意思 / 怎么回”），或等几秒自动分析。',
        '2. *发送导出聊天文件*：在 WhatsApp 对话右上角「导出聊天记录 (Export Chat)」得到 `.txt` 或 `.zip` 后直接发给我，可附带文字提问。',
        '',
        `*当前状态：* 模式 \`${currentMode}\`（${modeInfo.label}） | 模型 \`${config.model}\``,
        `*转发模式：* ${forwardBehavior}`,
        '',
        '*可用指令：*',
        '• `/analyze [问题]` — 立即分析当前暂存的转发记录',
        '• `/collect` — 开启/关闭手动收集模式（适合分多批跨聊天转发）',
        '• `/buffer` — 查看当前已暂存的转发记录条数与预览',
        '• `/clear` — 清空尚未分析的转发暂存区',
        '• `/mode [名称]` — 查看或切换分析模式',
        '• `/reset` — 清空当前会话记忆与转发暂存区',
        '• `/help` — 查看本帮助说明',
        '',
        '*可选分析模式：*',
        modeLines,
        '',
        '_提示：本项目需自备 API Key；基于非官方协议接入，存在风控封号风险，请自负其责并建议使用小号。_'
    ].join('\n');
}

module.exports = {
    DEFAULT_SYSTEM_PROMPT,
    ANALYSIS_MODES,
    MODE_NAMES,
    getBaseSystemPrompt,
    buildSystemPrompt,
    buildForwardedAnalysisPrompt,
    buildExportedChatPrompt,
    buildHelpText
};
