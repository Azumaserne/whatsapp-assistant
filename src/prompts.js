const fs = require('fs');
const { normalizeLang, t } = require('./i18n');

const DEFAULT_SYSTEM_PROMPT = [
    '你是一个接入 WhatsApp 的智能助手，擅长直接分析用户转发给你的 WhatsApp 聊天记录和导出的聊天文件（.txt / .zip），无需用户截图。',
    '请用适合手机阅读的清晰结构回答，包含核心脉络/结论、关键信息/情绪与潜台词、建议与回复参考。',
    '如果用户附带了具体问题，优先精准回答该问题；不要编造未在聊天记录中出现的事实。'
].join('\n');

const MODE_NAMES = ['general', 'summary', 'emotion', 'reply', 'translate'];

function getModeDetails(mode, lang = 'zh') {
    const validMode = MODE_NAMES.includes(mode) ? mode : 'general';
    return {
        name: validMode,
        label: t(lang, `mode.${validMode}.label`),
        description: t(lang, `mode.${validMode}.desc`),
        instruction: t(lang, `mode.${validMode}.inst`)
    };
}

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
 * Build full system prompt combining hot-reloaded prompt.txt, mode instruction, and active UI language.
 * @param {string} promptFile
 * @param {string} [mode]
 * @param {string} [lang]
 * @returns {string}
 */
function buildSystemPrompt(promptFile, mode = 'general', lang = 'zh') {
    const activeLang = normalizeLang(lang, 'zh');
    const base = getBaseSystemPrompt(promptFile);
    const modeInfo = getModeDetails(mode, activeLang);

    const parts = [base, modeInfo.instruction];
    if (activeLang === 'en') {
        parts.push('Important: Respond to the user in English (unless they explicitly ask for another target language).');
    } else if (activeLang === 'de') {
        parts.push('Wichtig: Antworte dem Nutzer auf Deutsch (sofern er nicht ausdrücklich eine andere Zielsprache verlangt).');
    }
    return parts.join('\n\n');
}

/**
 * Build user prompt for analyzing directly forwarded WhatsApp messages.
 * @param {string} transcript
 * @param {string} [userQuestion]
 * @param {string} [mode]
 * @param {string} [lang]
 * @returns {string}
 */
function buildForwardedAnalysisPrompt(transcript, userQuestion = '', mode = 'general', lang = 'zh') {
    const activeLang = normalizeLang(lang, 'zh');
    const modeInfo = getModeDetails(mode, activeLang);
    const trimmedQuestion = String(userQuestion || '').trim();

    const parts = [
        transcript,
        t(activeLang, 'prompt.mode_line', { label: modeInfo.label, desc: modeInfo.description })
    ];

    if (trimmedQuestion) {
        parts.push(t(activeLang, 'prompt.question_line', { question: trimmedQuestion }));
    } else {
        parts.push(t(activeLang, 'prompt.no_question_forward'));
    }

    return parts.join('\n\n');
}

/**
 * Build user prompt for analyzing a parsed WhatsApp Export Chat (.txt / .zip) document.
 * @param {{ filename: string, entryName?: string|null, text: string, totalChars: number, keptChars: number, truncated: boolean }} exportResult
 * @param {string} [userQuestion]
 * @param {string} [mode]
 * @param {string} [lang]
 * @returns {string}
 */
function buildExportedChatPrompt(exportResult, userQuestion = '', mode = 'general', lang = 'zh') {
    const activeLang = normalizeLang(lang, 'zh');
    const modeInfo = getModeDetails(mode, activeLang);
    const trimmedQuestion = String(userQuestion || '').trim();

    const sourceLabel = exportResult.entryName
        ? `${exportResult.filename} (${exportResult.entryName})`
        : exportResult.filename;

    const headerLines = [
        t(activeLang, 'prompt.export_header', { source: sourceLabel }),
        exportResult.truncated
            ? t(activeLang, 'prompt.export_truncated', { total: exportResult.totalChars, kept: exportResult.keptChars })
            : t(activeLang, 'prompt.export_full', { total: exportResult.totalChars })
    ];

    const parts = [
        headerLines.join('\n'),
        `${t(activeLang, 'prompt.export_begin')}\n${exportResult.text}\n${t(activeLang, 'prompt.export_end')}`,
        t(activeLang, 'prompt.mode_line', { label: modeInfo.label, desc: modeInfo.description })
    ];

    if (trimmedQuestion) {
        parts.push(t(activeLang, 'prompt.question_line', { question: trimmedQuestion }));
    } else {
        parts.push(t(activeLang, 'prompt.no_question_export'));
    }

    return parts.join('\n\n');
}

/**
 * Build a user-facing WhatsApp warning when the active model is non-multimodal or unverified.
 * @param {{ model: string, lang?: string, multimodal?: { supported?: boolean, status?: string } }} config
 * @param {'initial'|'forwarded_media'|'media'} [reason]
 * @param {string} [lang]
 * @returns {string|null}
 */
function buildNonMultimodalWarning(config, reason = 'initial', lang = undefined) {
    const multimodal = config?.multimodal;
    if (multimodal && multimodal.supported) {
        return null;
    }

    const activeLang = normalizeLang(lang || config?.lang, 'zh');
    const modelName = config?.model || 'model';
    const isUnknown = multimodal?.status === 'unknown';
    const prefix = isUnknown ? 'warn.unknown' : 'warn.nonmm';
    const validReason = ['forwarded_media', 'media', 'initial'].includes(reason) ? reason : 'initial';

    return t(activeLang, `${prefix}.${validReason}`, { model: modelName });
}

/**
 * Build user-facing WhatsApp help message.
 * @param {{ forwardAutoAnalyze: boolean, forwardDebounceMs: number, model: string, lang?: string, multimodal?: { supported?: boolean, status?: string } }} config
 * @param {string} [currentMode]
 * @param {string} [lang]
 * @returns {string}
 */
function buildHelpText(config, currentMode = 'general', lang = undefined) {
    const activeLang = normalizeLang(lang || config?.lang, 'zh');
    const modeInfo = getModeDetails(currentMode, activeLang);
    const forwardBehavior = config.forwardAutoAnalyze
        ? t(activeLang, 'help.fwd.auto', { sec: Math.round(config.forwardDebounceMs / 1000) })
        : t(activeLang, 'help.fwd.manual');

    let mmKey = 'help.mm.supported';
    if (!config.multimodal?.supported) {
        mmKey = config.multimodal?.status === 'unknown' ? 'help.mm.unknown' : 'help.mm.nonmm';
    }
    const mmTag = t(activeLang, mmKey);

    const activeModeName = MODE_NAMES.includes(currentMode) ? currentMode : 'general';
    const modeLines = MODE_NAMES.map((name) => {
        const item = getModeDetails(name, activeLang);
        const marker = name === activeModeName ? t(activeLang, 'help.current_tag') : '';
        return `• ${name}${marker}: ${item.label} - ${item.description}`;
    }).join('\n');

    return [
        t(activeLang, 'help.title'),
        t(activeLang, 'help.subtitle'),
        '',
        t(activeLang, 'help.usage_title'),
        t(activeLang, 'help.usage_1'),
        t(activeLang, 'help.usage_2'),
        '',
        t(activeLang, 'help.status_line', {
            mode: activeModeName,
            modeLabel: modeInfo.label,
            model: config.model,
            mmTag,
            lang: activeLang
        }),
        t(activeLang, 'help.forward_line', { behavior: forwardBehavior }),
        '',
        t(activeLang, 'help.cmds_title'),
        t(activeLang, 'help.cmd.analyze'),
        t(activeLang, 'help.cmd.collect'),
        t(activeLang, 'help.cmd.buffer'),
        t(activeLang, 'help.cmd.clear'),
        t(activeLang, 'help.cmd.mode'),
        t(activeLang, 'help.cmd.lang'),
        t(activeLang, 'help.cmd.reset'),
        t(activeLang, 'help.cmd.help'),
        '',
        t(activeLang, 'help.modes_title'),
        modeLines,
        '',
        t(activeLang, 'help.disclaimer')
    ].join('\n');
}

module.exports = {
    DEFAULT_SYSTEM_PROMPT,
    MODE_NAMES,
    getModeDetails,
    getBaseSystemPrompt,
    buildSystemPrompt,
    buildForwardedAnalysisPrompt,
    buildExportedChatPrompt,
    buildNonMultimodalWarning,
    buildHelpText
};
