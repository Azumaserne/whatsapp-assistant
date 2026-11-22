const { t } = require('./i18n');

/**
 * Lazily construct an OpenAI-compatible SDK client so unit tests need not load `openai`.
 * @param {{ apiKey: string, baseUrl: string, timeoutMs?: number }} config
 */
function createOpenAIClient(config) {
    const OpenAI = require('openai');
    return new OpenAI({
        apiKey: config.apiKey,
        baseURL: config.baseUrl,
        timeout: config.timeoutMs || 60000
    });
}

/**
 * Wrap an OpenAI-compatible client into a simple chat completion service.
 * @param {{ client: object, model: string, temperature?: number, maxTokens?: number }} options
 */
function createLlmService({ client, model, temperature = 0.7, maxTokens = 1500 }) {
    return {
        async complete(messages) {
            const completion = await client.chat.completions.create({
                model,
                messages,
                temperature,
                max_tokens: maxTokens
            });

            const content = completion?.choices?.[0]?.message?.content;
            if (!content || !String(content).trim()) {
                throw new Error('模型返回了空内容，请稍后重试或检查模型配置');
            }
            return String(content).trim();
        }
    };
}

/**
 * Split long replies into WhatsApp-friendly chunks at paragraph, line, or whitespace boundaries.
 * @param {string} text
 * @param {number} [maxLen]
 * @returns {string[]}
 */
function splitLongMessage(text, maxLen = 3500) {
    const normalized = String(text || '').trim();
    if (!normalized) return [];
    if (normalized.length <= maxLen) return [normalized];

    const chunks = [];
    let remaining = normalized;

    while (remaining.length > maxLen) {
        const window = remaining.slice(0, maxLen);
        let splitIdx = window.lastIndexOf('\n\n');
        if (splitIdx < maxLen * 0.4) {
            splitIdx = window.lastIndexOf('\n');
        }
        if (splitIdx < maxLen * 0.4) {
            splitIdx = window.lastIndexOf(' ');
        }
        if (splitIdx <= 0) {
            splitIdx = maxLen;
        }

        const chunk = remaining.slice(0, splitIdx).trim();
        if (chunk) {
            chunks.push(chunk);
        }
        remaining = remaining.slice(splitIdx).trim();
    }

    if (remaining) {
        chunks.push(remaining);
    }
    return chunks;
}

/**
 * Translate API and transport errors into actionable user-facing messages.
 * @param {any} error
 * @param {string} [lang]
 * @returns {string}
 */
function formatLlmError(error, lang = 'zh') {
    const status = error?.status ?? error?.response?.status;
    const msg = String(error?.message || '');
    const lowerMsg = msg.toLowerCase();

    if (status === 401 || status === 403) {
        return t(lang, 'err.401');
    }
    if (status === 402) {
        return t(lang, 'err.402');
    }
    if (status === 404) {
        return t(lang, 'err.404');
    }
    if (status === 429) {
        return t(lang, 'err.429');
    }
    if (status >= 500) {
        return t(lang, 'err.5xx', { status });
    }
    if (
        lowerMsg.includes('timeout') ||
        lowerMsg.includes('etimedout') ||
        lowerMsg.includes('abort')
    ) {
        return t(lang, 'err.timeout');
    }
    if (
        lowerMsg.includes('econnrefused') ||
        lowerMsg.includes('enotfound') ||
        lowerMsg.includes('fetch failed') ||
        lowerMsg.includes('network')
    ) {
        return t(lang, 'err.network');
    }

    return t(lang, 'err.generic', { msg: msg || 'Unknown error' });
}

module.exports = {
    createOpenAIClient,
    createLlmService,
    splitLongMessage,
    formatLlmError
};
