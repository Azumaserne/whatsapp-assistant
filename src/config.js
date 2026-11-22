const path = require('path');

const PLACEHOLDER_KEY_PATTERNS = [
    'your-api-key',
    '请替换',
    'sk-xxx',
    'replace-me'
];

/**
 * Extract normalized digits from a phone number or WhatsApp JID.
 * @param {string|null|undefined} raw
 * @returns {string}
 */
function normalizePhone(raw) {
    if (raw === null || raw === undefined) return '';
    const localPart = String(raw).split('@')[0];
    return localPart.replace(/\D/g, '');
}

function parseBoolean(value, defaultValue) {
    if (value === undefined || value === null || String(value).trim() === '') {
        return defaultValue;
    }
    const normalized = String(value).trim().toLowerCase();
    if (['true', '1', 'yes', 'on'].includes(normalized)) return true;
    if (['false', '0', 'no', 'off'].includes(normalized)) return false;
    return defaultValue;
}

function parseNumber(value, defaultValue, { min = -Infinity, max = Infinity, integer = false } = {}) {
    if (value === undefined || value === null || String(value).trim() === '') {
        return defaultValue;
    }
    const num = Number(value);
    if (!Number.isFinite(num)) return defaultValue;
    const clamped = Math.min(max, Math.max(min, num));
    return integer ? Math.floor(clamped) : clamped;
}

function parseAllowedNumbers(raw) {
    const allowed = new Set();
    if (!raw) return allowed;

    for (const token of String(raw).split(/[,;]/)) {
        const trimmed = token.trim();
        if (!trimmed) continue;
        if (trimmed.includes('@')) {
            allowed.add(trimmed.toLowerCase());
        }
        const digits = normalizePhone(trimmed);
        if (digits) {
            allowed.add(digits);
        }
    }
    return allowed;
}

/**
 * Resolve runtime configuration from environment variables with legacy DeepSeek fallback.
 * @param {Record<string, string|undefined>} [env]
 * @param {string} [baseDir]
 */
function loadConfig(env = process.env, baseDir = path.resolve(__dirname, '..')) {
    const llmKey = (env.LLM_API_KEY || '').trim();
    const openaiKey = (env.OPENAI_API_KEY || '').trim();
    const deepseekKey = (env.DEEPSEEK_API_KEY || '').trim();

    const usingLegacyDeepseek = !llmKey && !openaiKey && Boolean(deepseekKey);
    const apiKey = llmKey || openaiKey || deepseekKey;

    const explicitBaseUrl = (env.LLM_BASE_URL || env.OPENAI_BASE_URL || '').trim();
    const explicitModel = (env.LLM_MODEL || env.OPENAI_MODEL || '').trim();

    const baseUrl = explicitBaseUrl || (
        usingLegacyDeepseek ? 'https://api.deepseek.com' : 'https://api.openai.com/v1'
    );
    const model = explicitModel || (
        usingLegacyDeepseek ? 'deepseek-chat' : 'gpt-4o-mini'
    );

    const delayMin = parseNumber(env.REPLY_DELAY_MIN_MS, 1200, { min: 0, max: 30000, integer: true });
    const delayMaxRaw = parseNumber(env.REPLY_DELAY_MAX_MS, 3000, { min: 0, max: 30000, integer: true });
    const replyDelayMinMs = Math.min(delayMin, delayMaxRaw);
    const replyDelayMaxMs = Math.max(delayMin, delayMaxRaw);

    const selfChatReplyPrefix = (env.SELF_CHAT_REPLY_PREFIX !== undefined && env.SELF_CHAT_REPLY_PREFIX !== '')
        ? env.SELF_CHAT_REPLY_PREFIX
        : '🤖 ';

    return {
        apiKey,
        baseUrl,
        model,
        temperature: parseNumber(env.LLM_TEMPERATURE, 0.7, { min: 0, max: 2 }),
        maxTokens: parseNumber(env.LLM_MAX_TOKENS, 1500, { min: 64, max: 32000, integer: true }),
        timeoutMs: parseNumber(env.LLM_TIMEOUT_MS, 60000, { min: 5000, max: 300000, integer: true }),
        forwardAutoAnalyze: parseBoolean(env.FORWARD_AUTO_ANALYZE, true),
        forwardDebounceMs: parseNumber(env.FORWARD_DEBOUNCE_MS, 6000, { min: 50, max: 120000, integer: true }),
        maxChatExportChars: parseNumber(env.MAX_CHAT_EXPORT_CHARS, 60000, { min: 1000, max: 500000, integer: true }),
        maxHistory: parseNumber(env.MAX_HISTORY, 24, { min: 2, max: 200, integer: true }),
        allowedNumbers: parseAllowedNumbers(env.ALLOWED_NUMBERS),
        enableSelfChat: parseBoolean(env.ENABLE_SELF_CHAT, false),
        selfChatReplyPrefix,
        replyDelayMinMs,
        replyDelayMaxMs,
        chromePath: (env.CHROME_PATH || '').trim() || undefined,
        promptFile: path.join(baseDir, 'prompt.txt'),
        memoryFile: path.join(baseDir, 'memory.json')
    };
}

/**
 * Check whether an API key is configured and not an obvious placeholder.
 * @param {{ apiKey?: string }} config
 * @returns {boolean}
 */
function hasValidApiKey(config) {
    const key = (config && config.apiKey ? String(config.apiKey) : '').trim();
    if (!key) return false;
    const lower = key.toLowerCase();
    return !PLACEHOLDER_KEY_PATTERNS.some((pattern) => lower.includes(pattern));
}

/**
 * Check whether a sender is allowed to interact with the assistant.
 * Supports empty whitelist (allow all DMs), raw JID match, phone digits, and LID contact numbers.
 * @param {{ allowedNumbers: Set<string> }} config
 * @param {string} senderId
 * @param {string|null} [contactNumber]
 * @returns {boolean}
 */
function isSenderAllowed(config, senderId, contactNumber = null) {
    if (!config.allowedNumbers || config.allowedNumbers.size === 0) {
        return true;
    }

    const senderLower = String(senderId || '').trim().toLowerCase();
    if (senderLower && config.allowedNumbers.has(senderLower)) {
        return true;
    }

    const senderDigits = normalizePhone(senderId);
    if (senderDigits && config.allowedNumbers.has(senderDigits)) {
        return true;
    }

    const contactDigits = normalizePhone(contactNumber);
    if (contactDigits && config.allowedNumbers.has(contactDigits)) {
        return true;
    }

    return false;
}

module.exports = {
    loadConfig,
    hasValidApiKey,
    isSenderAllowed,
    normalizePhone
};
