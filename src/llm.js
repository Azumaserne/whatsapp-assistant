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
 * Translate API and transport errors into actionable Chinese user-facing messages.
 * @param {any} error
 * @returns {string}
 */
function formatLlmError(error) {
    const status = error?.status ?? error?.response?.status;
    const msg = String(error?.message || '');
    const lowerMsg = msg.toLowerCase();

    if (status === 401 || status === 403) {
        return '❌ API Key 无效或无权限（401/403），请检查 `.env` 中的 `LLM_API_KEY` 与接口地址是否正确。';
    }
    if (status === 402) {
        return '❌ API 账户余额不足或额度已用完（402），请检查你的服务商账户余额。';
    }
    if (status === 404) {
        return '❌ 模型或接口路径不存在（404），请检查 `.env` 中的 `LLM_BASE_URL` 和 `LLM_MODEL`。';
    }
    if (status === 429) {
        return '⏳ API 请求过于频繁或触发限流（429），请稍后再试。';
    }
    if (status >= 500) {
        return `⚠️ 模型服务商暂时异常（HTTP ${status}），请稍后重试。`;
    }
    if (
        lowerMsg.includes('timeout') ||
        lowerMsg.includes('etimedout') ||
        lowerMsg.includes('abort')
    ) {
        return '⏳ 调用大模型超时，请检查网络连接或适当调大 `.env` 中的 `LLM_TIMEOUT_MS`。';
    }
    if (
        lowerMsg.includes('econnrefused') ||
        lowerMsg.includes('enotfound') ||
        lowerMsg.includes('fetch failed') ||
        lowerMsg.includes('network')
    ) {
        return '🌐 无法连接到配置的 API 地址，请检查网络、代理设置或 `LLM_BASE_URL`。';
    }

    return `❌ 分析失败：${msg || '未知错误'}`;
}

module.exports = {
    createOpenAIClient,
    createLlmService,
    splitLongMessage,
    formatLlmError
};
