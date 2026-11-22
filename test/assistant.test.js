const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');

const { loadConfig, hasValidApiKey, isSenderAllowed, normalizePhone, detectModelMultimodal } = require('../src/config');
const { resolveExplicitLang, normalizeLang, t } = require('../src/i18n');
const { isChatExportDocument, extractTextFromZipBuffer, truncateChatHistoryTail, parseChatExportMedia } = require('../src/chatExport');
const { ForwardSessionManager } = require('../src/forwardBuffer');
const { MemoryStore } = require('../src/memory');
const { createLlmService, splitLongMessage, formatLlmError } = require('../src/llm');
const { createDesktopRecorder, formatDateKey } = require('../src/recorder');
const { parseEnvText, serializeEnvMap, buildSetupSummaryText } = require('../src/cli');
const { createMessageHandler } = require('../src/handler');

/**
 * Build a minimal spec-valid ZIP archive buffer in memory for testing.
 */
function buildZipBuffer(entries) {
    const localChunks = [];
    const cdChunks = [];
    let offset = 0;

    for (const entry of entries) {
        const nameBuf = Buffer.from(entry.name, 'utf-8');
        const rawBuf = Buffer.isBuffer(entry.content) ? entry.content : Buffer.from(entry.content || '', 'utf-8');
        const method = entry.method ?? 8;
        const compressed = method === 8 ? zlib.deflateRawSync(rawBuf) : rawBuf;
        const crc = zlib.crc32 ? zlib.crc32(rawBuf) : 0;
        const generalFlag = (entry.generalFlag ?? 0) | 0x0800;

        const lfh = Buffer.alloc(30);
        lfh.writeUInt32LE(0x04034b50, 0);
        lfh.writeUInt16LE(20, 4);
        lfh.writeUInt16LE(generalFlag, 6);
        lfh.writeUInt16LE(method, 8);
        lfh.writeUInt32LE(crc >>> 0, 14);
        lfh.writeUInt32LE(compressed.length, 18);
        lfh.writeUInt32LE(rawBuf.length, 22);
        lfh.writeUInt16LE(nameBuf.length, 26);
        lfh.writeUInt16LE(0, 28);

        localChunks.push(lfh, nameBuf, compressed);

        const cd = Buffer.alloc(46);
        cd.writeUInt32LE(0x02014b50, 0);
        cd.writeUInt16LE(20, 4);
        cd.writeUInt16LE(20, 6);
        cd.writeUInt16LE(generalFlag, 8);
        cd.writeUInt16LE(method, 10);
        cd.writeUInt32LE(crc >>> 0, 16);
        cd.writeUInt32LE(compressed.length, 20);
        cd.writeUInt32LE(rawBuf.length, 24);
        cd.writeUInt16LE(nameBuf.length, 28);
        cd.writeUInt32LE(offset, 42);

        cdChunks.push(cd, nameBuf);
        offset += lfh.length + nameBuf.length + compressed.length;
    }

    const cdBuf = Buffer.concat(cdChunks);
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(entries.length, 8);
    eocd.writeUInt16LE(entries.length, 10);
    eocd.writeUInt32LE(cdBuf.length, 12);
    eocd.writeUInt32LE(offset, 16);

    return Buffer.concat([...localChunks, cdBuf, eocd]);
}

function createTestHarness(envOverrides = {}) {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-assistant-test-'));
    const promptPath = path.join(tmpDir, 'prompt.txt');
    fs.writeFileSync(promptPath, '测试系统提示词', 'utf-8');

    const config = loadConfig({
        LLM_API_KEY: 'sk-test-valid-key-12345',
        FORWARD_DEBOUNCE_MS: '60',
        REPLY_DELAY_MIN_MS: '0',
        REPLY_DELAY_MAX_MS: '0',
        ...envOverrides
    }, tmpDir);

    const llmCalls = [];
    let replySeq = 0;
    const llm = {
        async complete(messages) {
            llmCalls.push(messages);
            replySeq += 1;
            return `AI分析结果 #${replySeq}`;
        }
    };

    const memory = new MemoryStore({ filePath: null, maxHistory: config.maxHistory });
    const forwardManager = new ForwardSessionManager({
        debounceMs: config.forwardDebounceMs,
        autoAnalyze: config.forwardAutoAnalyze
    });

    const replies = [];
    let outgoingId = 0;

    const handler = createMessageHandler({
        config,
        llm,
        memory,
        forwardManager,
        sendReply: async (sender, text) => {
            outgoingId += 1;
            const id = `bot-msg-${outgoingId}`;
            replies.push({ id, sender, text });
            return id;
        },
        setTyping: async () => {},
        clearTyping: async () => {},
        sleep: async () => {},
        logger: { error: () => {}, warn: () => {}, log: () => {} }
    });

    const cleanup = () => {
        forwardManager.dispose();
        fs.rmSync(tmpDir, { recursive: true, force: true });
    };

    return { config, llmCalls, memory, forwardManager, replies, handler, cleanup };
}

test('config: resolves defaults, legacy DeepSeek fallback, placeholders, and whitelist matching', () => {
    const defaultCfg = loadConfig({});
    assert.equal(defaultCfg.baseUrl, 'https://api.openai.com/v1');
    assert.equal(defaultCfg.model, 'gpt-4o-mini');
    assert.equal(hasValidApiKey(defaultCfg), false);

    const legacyCfg = loadConfig({ DEEPSEEK_API_KEY: 'sk-ds-real' });
    assert.equal(legacyCfg.apiKey, 'sk-ds-real');
    assert.equal(legacyCfg.baseUrl, 'https://api.deepseek.com');
    assert.equal(legacyCfg.model, 'deepseek-chat');
    assert.equal(hasValidApiKey(legacyCfg), true);

    const customCfg = loadConfig({
        LLM_API_KEY: 'sk-or-custom',
        LLM_BASE_URL: 'https://openrouter.ai/api/v1',
        LLM_MODEL: 'anthropic/claude-3.5-sonnet',
        ALLOWED_NUMBERS: '+86 138-0013-8000, 999888@lid',
        ENABLE_SELF_CHAT: 'true',
        FORWARD_AUTO_ANALYZE: 'false'
    });
    assert.equal(customCfg.baseUrl, 'https://openrouter.ai/api/v1');
    assert.equal(customCfg.model, 'anthropic/claude-3.5-sonnet');
    assert.equal(customCfg.enableSelfChat, true);
    assert.equal(customCfg.forwardAutoAnalyze, false);
    assert.equal(normalizePhone('+86 138-0013-8000'), '8613800138000');
    assert.equal(isSenderAllowed(customCfg, '8613800138000@c.us'), true);
    assert.equal(isSenderAllowed(customCfg, '111222@lid', '8613800138000'), true);
    assert.equal(isSenderAllowed(customCfg, '999888@lid'), true);
    assert.equal(isSenderAllowed(customCfg, '14155550199@c.us'), false);

    assert.equal(hasValidApiKey({ apiKey: 'your-api-key-here' }), false);
    assert.equal(hasValidApiKey({ apiKey: '请替换为你的key' }), false);
    assert.equal(hasValidApiKey({ apiKey: 'sk-xxx' }), false);
});

test('chatExport: detects types, unpacks deflated & stored ZIPs prioritizing _chat.txt, and truncates tail cleanly', () => {
    assert.equal(isChatExportDocument('WhatsApp Chat.zip', 'application/octet-stream'), 'zip');
    assert.equal(isChatExportDocument('history.txt', 'text/plain'), 'text');
    assert.equal(isChatExportDocument('screenshot.png', 'image/png'), null);

    const zipBuf = buildZipBuffer([
        { name: '__MACOSX/._chat.txt', content: 'junk', method: 0 },
        { name: 'notes.txt', content: 'unrelated notes', method: 0 },
        { name: '_chat.txt', content: '\uFEFF[2026/11/20] Alice: 你好\r\n[2026/11/20] Bob: 方案发我看看', method: 8 }
    ]);

    const extracted = extractTextFromZipBuffer(zipBuf);
    assert.equal(extracted.entryName, '_chat.txt');
    assert.match(extracted.text, /方案发我看看/);

    const parsedZip = parseChatExportMedia({
        filename: 'WhatsApp Chat with Bob.zip',
        mimetype: 'application/zip',
        data: zipBuf.toString('base64')
    }, 5000);
    assert.equal(parsedZip.truncated, false);
    assert.equal(parsedZip.entryName, '_chat.txt');
    assert.equal(parsedZip.text.startsWith('[2026/11/20] Alice:'), true);

    const longLines = Array.from({ length: 50 }, (_, i) => `Line ${i}: hello world message`).join('\n');
    const tail = truncateChatHistoryTail(longLines, 120);
    assert.equal(tail.truncated, true);
    assert.ok(tail.keptChars <= 120);
    assert.ok(tail.text.includes('Line 49:'));
    assert.equal(tail.text.startsWith('Line '), true);

    const encryptedZip = buildZipBuffer([
        { name: '_chat.txt', content: 'secret', method: 0, generalFlag: 0x0001 }
    ]);
    assert.throws(() => extractTextFromZipBuffer(encryptedZip), /加密/);
    assert.throws(() => extractTextFromZipBuffer(Buffer.from('not-a-zip')), /ZIP/);
});

test('handler: batches multi-select forwarded messages into 1 LLM call', async () => {
    const h = createTestHarness();
    try {
        const sender = '8613800138000@c.us';
        for (let i = 1; i <= 5; i += 1) {
            await h.handler({
                from: sender,
                body: `转发消息第 ${i} 条`,
                isForwarded: true,
                timestamp: 1700000000 + i * 60
            });
        }

        await new Promise((r) => setTimeout(r, 150));

        assert.equal(h.llmCalls.length, 1);
        assert.equal(h.replies.length, 1);
        const promptSent = h.llmCalls[0].at(-1).content;
        assert.match(promptSent, /共 5 条/);
        assert.match(promptSent, /1\. .*转发消息第 1 条/);
        assert.match(promptSent, /5\. .*转发消息第 5 条/);
    } finally {
        h.cleanup();
    }
});

test('handler: combines pending forwarded messages with immediate follow-up question in 1 call', async () => {
    const h = createTestHarness({ FORWARD_DEBOUNCE_MS: '200' });
    try {
        const sender = '8613800138000@c.us';
        await h.handler({ from: sender, body: '我们下周三再签合同吧', isForwarded: true });
        await h.handler({ from: sender, body: '价格还可以再谈一点吗', isForwarded: true });
        await h.handler({ from: sender, body: '对方是不是在拖延？怎么回比较好' });

        // Wait past original debounce to ensure timer was cancelled and did not double-fire
        await new Promise((r) => setTimeout(r, 260));

        assert.equal(h.llmCalls.length, 1);
        assert.equal(h.replies.length, 1);
        const userPrompt = h.llmCalls[0].at(-1).content;
        assert.match(userPrompt, /我们下周三再签合同吧/);
        assert.match(userPrompt, /价格还可以再谈一点吗/);
        assert.match(userPrompt, /对方是不是在拖延？怎么回比较好/);
    } finally {
        h.cleanup();
    }
});

test('handler: supports /collect, /buffer, and /analyze workflow across batches', async () => {
    const h = createTestHarness({ FORWARD_DEBOUNCE_MS: '50' });
    try {
        const sender = 'user1@c.us';
        await h.handler({ from: sender, body: '/collect' });
        await h.handler({ from: sender, body: 'A群消息1', isForwarded: true });
        await new Promise((r) => setTimeout(r, 100));
        // Should NOT auto-analyze while in /collect mode
        assert.equal(h.llmCalls.length, 0);

        await h.handler({ from: sender, body: 'B群消息2', isForwarded: true });
        await h.handler({ from: sender, body: '/buffer' });
        assert.match(h.replies.at(-1).text, /共 \*2\* 条转发记录/);

        // Regular text while in /collect reminds instead of analyzing early
        await h.handler({ from: sender, body: '帮我总结' });
        assert.equal(h.llmCalls.length, 0);
        assert.match(h.replies.at(-1).text, /手动收集模式/);

        await h.handler({ from: sender, body: '/analyze 帮我对比两边说法' });
        assert.equal(h.llmCalls.length, 1);
        const prompt = h.llmCalls[0].at(-1).content;
        assert.match(prompt, /A群消息1/);
        assert.match(prompt, /B群消息2/);
        assert.match(prompt, /帮我对比两边说法/);
        assert.equal(h.forwardManager.getStatus(sender).collectMode, false);
    } finally {
        h.cleanup();
    }
});

test('handler: handles manual mode (FORWARD_AUTO_ANALYZE=false), forwarded media tags, and screenshot guidance', async () => {
    const h = createTestHarness({ FORWARD_AUTO_ANALYZE: 'false', FORWARD_DEBOUNCE_MS: '50' });
    try {
        const sender = 'user2@c.us';
        await h.handler({ from: sender, body: '', hasMedia: true, type: 'image', isForwarded: true });
        await h.handler({ from: sender, body: '这段语音什么意思', hasMedia: true, type: 'ptt', isForwarded: true });

        await new Promise((r) => setTimeout(r, 120));
        assert.equal(h.llmCalls.length, 0);
        assert.equal(h.replies.length, 1);
        assert.match(h.replies[0].text, /已暂存 2 条转发记录/);

        await h.handler({ from: sender, body: '分析一下刚才发的' });
        assert.equal(h.llmCalls.length, 1);
        const prompt = h.llmCalls[0].at(-1).content;
        assert.match(prompt, /\[图片\]/);
        assert.match(prompt, /\[语音\]/);

        // Non-forwarded media without caption guides user not to send screenshots
        await h.handler({ from: sender, body: '', hasMedia: true, type: 'image', isForwarded: false });
        assert.match(h.replies.at(-1).text, /不需要发截图/);
    } finally {
        h.cleanup();
    }
});

test('handler: parses and analyzes exported .txt and .zip chat documents directly', async () => {
    const h = createTestHarness({ MAX_CHAT_EXPORT_CHARS: '1500' });
    try {
        const sender = 'user3@c.us';
        const txtContent = '\uFEFF11/20/26, 20:00 - Alice: 周五上线\n11/20/26, 20:05 - Bob: 收到，我负责回归测试';

        await h.handler({
            from: sender,
            body: '提取待办事项',
            hasMedia: true,
            type: 'document',
            filename: 'chat.txt',
            mimetype: 'text/plain',
            downloadMedia: async () => ({
                filename: 'chat.txt',
                mimetype: 'text/plain',
                data: Buffer.from(txtContent, 'utf-8').toString('base64')
            })
        });

        assert.equal(h.llmCalls.length, 1);
        const txtPrompt = h.llmCalls[0].at(-1).content;
        assert.match(txtPrompt, /chat\.txt/);
        assert.match(txtPrompt, /我负责回归测试/);
        assert.match(txtPrompt, /提取待办事项/);

        const longChat = Array.from({ length: 80 }, (_, idx) => `2026/11/21 10:${String(idx % 60).padStart(2, '0')} - User: 第${idx}条记录`).join('\n');
        const zipBuffer = buildZipBuffer([{ name: '_chat.txt', content: longChat, method: 8 }]);

        await h.handler({
            from: sender,
            body: '',
            hasMedia: true,
            type: 'document',
            filename: 'WhatsApp Chat.zip',
            mimetype: 'application/zip',
            downloadMedia: async () => ({
                filename: 'WhatsApp Chat.zip',
                mimetype: 'application/zip',
                data: zipBuffer.toString('base64')
            })
        });

        assert.equal(h.llmCalls.length, 2);
        const zipPrompt = h.llmCalls[1].at(-1).content;
        assert.match(zipPrompt, /WhatsApp Chat\.zip \(_chat\.txt\)/);
        assert.match(zipPrompt, /保留了最新/);
    } finally {
        h.cleanup();
    }
});

test('handler: supports quoted context, /mode, /help, /clear, /reset, and ignores groups/unauthorized/self-loops', async () => {
    const h = createTestHarness({
        ALLOWED_NUMBERS: '8613800138000',
        ENABLE_SELF_CHAT: 'true',
        SELF_CHAT_REPLY_PREFIX: '🤖 '
    });
    try {
        // Ignored messages: group, status, unauthorized user, non-self outgoing, bot-prefixed self message
        await h.handler({ from: '123456@g.us', body: 'hello' });
        await h.handler({ from: 'status@broadcast', body: 'status', isStatus: true });
        await h.handler({ from: '14155550199@c.us', body: 'hi', contactNumber: '14155550199' });
        await h.handler({ from: '8613800138000@c.us', to: 'other@c.us', fromMe: true, body: 'msg to friend' });
        await h.handler({ from: '8613800138000@c.us', to: '8613800138000@c.us', fromMe: true, body: '🤖 AI分析结果' });
        assert.equal(h.replies.length, 0);
        assert.equal(h.llmCalls.length, 0);

        const me = '8613800138000@c.us';
        await h.handler({ from: me, to: me, fromMe: true, body: '/help' });
        assert.equal(h.replies.length, 1);
        assert.equal(h.replies[0].text.startsWith('🤖 '), true);
        assert.match(h.replies[0].text, /无需截图/);

        await h.handler({ from: me, to: me, fromMe: true, body: '/mode reply' });
        assert.equal(h.memory.getMode(me), 'reply');

        await h.handler({
            from: me,
            to: me,
            fromMe: true,
            body: '这句话怎么回更合适？',
            hasQuotedMsg: true,
            quotedBody: '明天方案能不能提前交？'
        });
        assert.equal(h.llmCalls.length, 1);
        assert.match(h.llmCalls[0][0].content, /高情商回复/);
        assert.match(h.llmCalls[0].at(-1).content, /引用消息：明天方案能不能提前交/);

        await h.handler({ from: me, body: '一条转发', isForwarded: true });
        await h.handler({ from: me, body: '/clear' });
        assert.equal(h.forwardManager.getStatus(me).count, 0);

        await h.handler({ from: me, body: '/reset' });
        assert.equal(h.memory.getMode(me), 'general');
        assert.equal(h.memory.getMessages(me).length, 0);
    } finally {
        h.cleanup();
    }
});

test('memory: migrates legacy whatsapp-lover array format and persists trims', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-memory-test-'));
    const memFile = path.join(tmpDir, 'memory.json');
    try {
        fs.writeFileSync(memFile, JSON.stringify({
            'alice@c.us': [
                { role: 'system', content: 'old lover prompt' },
                { role: 'user', content: 'hi' },
                { role: 'assistant', content: 'hey' }
            ]
        }), 'utf-8');

        const store = new MemoryStore({ filePath: memFile, maxHistory: 4 });
        assert.equal(store.getMode('alice@c.us'), 'general');
        assert.deepEqual(store.getMessages('alice@c.us'), [
            { role: 'user', content: 'hi' },
            { role: 'assistant', content: 'hey' }
        ]);

        store.appendTurn('alice@c.us', 'q2', 'a2');
        store.appendTurn('alice@c.us', 'q3', 'a3');

        const reloaded = new MemoryStore({ filePath: memFile, maxHistory: 4 });
        assert.equal(reloaded.getMessages('alice@c.us').length, 4);
        assert.equal(reloaded.getMessages('alice@c.us')[0].content, 'q2');
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('llm: splits long replies cleanly and maps common API errors', async () => {
    const longText = [
        '第一段：'.padEnd(90, '甲'),
        '第二段：'.padEnd(90, '乙'),
        '第三段：'.padEnd(90, '丙')
    ].join('\n\n');

    const chunks = splitLongMessage(longText, 120);
    assert.equal(chunks.length, 3);
    assert.ok(chunks.every((c) => c.length <= 120));

    assert.match(formatLlmError({ status: 401 }), /401/);
    assert.match(formatLlmError({ status: 402 }), /402/);
    assert.match(formatLlmError({ status: 404 }), /404/);
    assert.match(formatLlmError({ status: 429 }), /429/);
    assert.match(formatLlmError(new Error('Request timeout exceeded')), /超时/);
    assert.match(formatLlmError(new Error('connect ECONNREFUSED 127.0.0.1:11434')), /无法连接/);

    const svc = createLlmService({
        client: {
            chat: {
                completions: {
                    create: async () => ({ choices: [{ message: { content: '  ok  ' } }] })
                }
            }
        },
        model: 'test-model'
    });
    assert.equal(await svc.complete([{ role: 'user', content: 'hi' }]), 'ok');
});

test('config: detects multimodal, non-multimodal, unknown models, and LLM_MULTIMODAL overrides', () => {
    for (const model of ['deepseek-chat', 'deepseek-reasoner', 'moonshot-v1-8k', 'glm-4-flash', 'qwen2.5:7b', 'o3-mini']) {
        const res = detectModelMultimodal(model);
        assert.equal(res.supported, false, `${model} should be non-multimodal`);
        assert.equal(res.status, 'non-multimodal');
        assert.equal(res.source, 'auto');
    }

    for (const model of ['gpt-4o-mini', 'gemini-2.5-flash', 'anthropic/claude-3.5-sonnet', 'glm-4v-flash', 'qwen2.5-vl-7b', 'o4-mini']) {
        const res = detectModelMultimodal(model);
        assert.equal(res.supported, true, `${model} should be multimodal`);
        assert.equal(res.status, 'multimodal');
        assert.equal(res.source, 'auto');
    }

    const unknown = detectModelMultimodal('my-private-model');
    assert.equal(unknown.supported, false);
    assert.equal(unknown.status, 'unknown');
    assert.equal(unknown.source, 'auto');

    assert.deepEqual(detectModelMultimodal('my-private-model', 'true'), {
        supported: true,
        status: 'multimodal',
        source: 'env'
    });
    assert.deepEqual(detectModelMultimodal('gpt-4o-mini', 'false'), {
        supported: false,
        status: 'non-multimodal',
        source: 'env'
    });
});

test('handler: warns user on non-multimodal model (first turn, forwarded media, direct image, and /help)', async () => {
    const h = createTestHarness({
        LLM_API_KEY: '',
        DEEPSEEK_API_KEY: 'sk-deepseek-valid-12345'
    });
    try {
        assert.equal(h.config.model, 'deepseek-chat');
        assert.equal(h.config.multimodal.supported, false);

        const sender = 'ds-user@c.us';

        // 1. First plain text turn emits initial warning + LLM reply
        await h.handler({ from: sender, body: '帮我分析一下今天的工作安排' });
        assert.equal(h.llmCalls.length, 1);
        assert.equal(h.replies.length, 2);
        assert.match(h.replies[0].text, /非多模态（纯文本）模型/);
        assert.match(h.replies[1].text, /AI分析结果 #1/);

        // 2. Second plain text turn should NOT repeat initial warning
        await h.handler({ from: sender, body: '再补充一点细节' });
        assert.equal(h.llmCalls.length, 2);
        assert.equal(h.replies.length, 3);
        assert.match(h.replies[2].text, /AI分析结果 #2/);

        // 3. Forwarded batch containing [图片] emits explicit forwarded_media warning
        await h.handler({ from: sender, body: '他刚发了这个图', isForwarded: true, hasMedia: true, type: 'image' });
        await h.handler({ from: sender, body: '你说怎么回', isForwarded: true });
        await new Promise((r) => setTimeout(r, 150));

        assert.equal(h.llmCalls.length, 3);
        assert.equal(h.replies.length, 5);
        assert.match(h.replies[3].text, /本次转发记录包含图片\/媒体消息.*非多模态/);
        assert.match(h.replies[4].text, /AI分析结果 #3/);

        // 4. Direct image without caption emits non-multimodal media warning (no LLM call)
        await h.handler({ from: sender, body: '', hasMedia: true, type: 'image', isForwarded: false });
        assert.equal(h.llmCalls.length, 3);
        assert.equal(h.replies.length, 6);
        assert.match(h.replies[5].text, /非多模态（纯文本）模型，无法识别图片\/媒体内容/);

        // 5. Direct image WITH caption emits non-multimodal media warning + text answer
        await h.handler({ from: sender, body: '帮我看看截图里说的啥', hasMedia: true, type: 'image', isForwarded: false });
        assert.equal(h.llmCalls.length, 4);
        assert.equal(h.replies.length, 8);
        assert.match(h.replies[6].text, /非多模态（纯文本）模型，无法识别图片\/媒体内容/);
        assert.match(h.replies[7].text, /AI分析结果 #4/);

        // 6. /help shows non-multimodal model status
        await h.handler({ from: sender, body: '/help' });
        assert.match(h.replies.at(-1).text, /deepseek-chat.*非多模态/);
    } finally {
        h.cleanup();
    }
});

test('handler: warns user when unknown model defaults to text-only and hints LLM_MULTIMODAL=true', async () => {
    const h = createTestHarness({
        LLM_MODEL: 'my-custom-model'
    });
    try {
        assert.equal(h.config.multimodal.status, 'unknown');
        const sender = 'unknown-model-user@c.us';

        await h.handler({ from: sender, body: '你好' });
        assert.equal(h.replies.length, 2);
        assert.match(h.replies[0].text, /LLM_MULTIMODAL=true/);
        assert.match(h.replies[1].text, /AI分析结果 #1/);

        await h.handler({ from: sender, body: '/help' });
        assert.match(h.replies.at(-1).text, /未知.*LLM_MULTIMODAL=true/);
    } finally {
        h.cleanup();
    }
});

test('handler: multimodal model emits no warning, attaches image_url parts, and stores text-only memory', async () => {
    const h = createTestHarness({
        LLM_MODEL: 'gpt-4o-mini'
    });
    try {
        assert.equal(h.config.multimodal.supported, true);
        const sender = 'mm-user@c.us';
        const fakePngBase64 = Buffer.from('fake-png-bytes').toString('base64');

        // Forwarded text + image -> vision payload sent to LLM, zero warnings, memory stays text-only
        await h.handler({ from: sender, body: '这是对方发来的报价单', isForwarded: true });
        await h.handler({
            from: sender,
            body: '你看看图里的价格',
            isForwarded: true,
            hasMedia: true,
            type: 'image',
            downloadMedia: async () => ({
                mimetype: 'image/png',
                data: fakePngBase64
            })
        });
        await new Promise((r) => setTimeout(r, 150));

        assert.equal(h.llmCalls.length, 1);
        assert.equal(h.replies.length, 1);
        assert.match(h.replies[0].text, /AI分析结果 #1/);

        const forwardedUserContent = h.llmCalls[0].at(-1).content;
        assert.equal(Array.isArray(forwardedUserContent), true);
        assert.equal(forwardedUserContent[0].type, 'text');
        assert.match(forwardedUserContent[0].text, /这是对方发来的报价单/);
        assert.equal(forwardedUserContent[1].type, 'image_url');
        assert.equal(forwardedUserContent[1].image_url.url, `data:image/png;base64,${fakePngBase64}`);

        // Direct image with caption also attaches image_url
        await h.handler({
            from: sender,
            body: '这张图什么意思',
            hasMedia: true,
            type: 'image',
            isForwarded: false,
            downloadMedia: async () => ({
                mimetype: 'image/jpeg',
                data: fakePngBase64
            })
        });
        assert.equal(h.llmCalls.length, 2);
        const directUserContent = h.llmCalls[1].at(-1).content;
        assert.equal(Array.isArray(directUserContent), true);
        assert.equal(directUserContent[1].image_url.url, `data:image/jpeg;base64,${fakePngBase64}`);

        // Verify MemoryStore kept only plain text (never base64 data URLs)
        const storedMessages = h.memory.getMessages(sender);
        assert.equal(storedMessages.length, 4);
        assert.equal(storedMessages.every((m) => typeof m.content === 'string' && !m.content.includes('data:image/')), true);

        // /help shows multimodal supported
        await h.handler({ from: sender, body: '/help' });
        assert.match(h.replies.at(-1).text, /支持多模态/);
    } finally {
        h.cleanup();
    }
});

test('recorder & DATA_DIR: resolves Desktop data paths, creates nested directories, and archives Markdown records', async () => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-desktop-data-'));
    try {
        const customDataDir = path.join(tmpRoot, 'Desktop', 'WhatsApp-Assistant-Data');
        const cfg = loadConfig({ LLM_API_KEY: 'sk-test', DATA_DIR: customDataDir }, tmpRoot);
        assert.equal(cfg.dataDir, path.resolve(customDataDir));
        assert.equal(cfg.memoryFile, path.join(path.resolve(customDataDir), 'memory.json'));
        assert.equal(cfg.recordsDir, path.join(path.resolve(customDataDir), 'records'));
        assert.equal(cfg.promptFile, path.join(tmpRoot, 'prompt.txt'));

        // MemoryStore creates missing parent directories automatically
        const memStore = new MemoryStore({ filePath: cfg.memoryFile, maxHistory: 10 });
        memStore.appendTurn('u1@c.us', 'hello', 'world');
        assert.equal(fs.existsSync(cfg.memoryFile), true);

        // createDesktopRecorder writes daily Markdown files with forwarded/export/chat labels
        const savedFiles = [];
        const recorder = createDesktopRecorder({
            recordsDir: cfg.recordsDir,
            onSaved: (p) => savedFiles.push(p)
        });
        const fixedDate = new Date(2026, 10, 22, 20, 45, 10);
        const writtenPath = recorder.record({
            sender: 'u1@c.us',
            kind: 'forwarded',
            mode: 'reply',
            model: 'gpt-4o-mini',
            inputText: '1. 明早开会',
            replyText: '收到，已安排',
            timestamp: fixedDate
        });
        assert.equal(writtenPath, path.join(cfg.recordsDir, `${formatDateKey(fixedDate)}.md`));
        assert.equal(savedFiles.length, 1);
        const mdContent = fs.readFileSync(writtenPath, 'utf-8');
        assert.match(mdContent, /转发聊天记录分析/);
        assert.match(mdContent, /`reply`/);
        assert.match(mdContent, /1\. 明早开会/);
        assert.match(mdContent, /收到，已安排/);

        // Handler passes kind='forwarded', 'export', 'chat' to recorder and survives recorder errors
        const recordedKinds = [];
        const throwingHandler = createMessageHandler({
            config: cfg,
            llm: { async complete() { return 'ok-reply'; } },
            memory: new MemoryStore({ filePath: null }),
            forwardManager: new ForwardSessionManager({ debounceMs: 40, autoAnalyze: true }),
            recorder: {
                record(entry) {
                    recordedKinds.push(entry.kind);
                    if (entry.kind === 'chat') {
                        throw new Error('disk full');
                    }
                }
            },
            sendReply: async () => 'id-1',
            sleep: async () => {},
            logger: { error: () => {}, warn: () => {}, log: () => {} }
        });

        await throwingHandler({ from: 'u1@c.us', body: '转发记录', isForwarded: true });
        await new Promise((r) => setTimeout(r, 100));
        await throwingHandler({
            from: 'u1@c.us',
            body: '',
            hasMedia: true,
            type: 'document',
            filename: 'chat.txt',
            mimetype: 'text/plain',
            downloadMedia: async () => ({
                filename: 'chat.txt',
                mimetype: 'text/plain',
                data: Buffer.from('A: hello', 'utf-8').toString('base64')
            })
        });
        await throwingHandler({ from: 'u1@c.us', body: '普通消息' });

        assert.deepEqual(recordedKinds, ['forwarded', 'export', 'chat']);
    } finally {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
});

test('i18n & /lang: supports zh/en/de switching, localized warnings, /help, and LLM errors', async () => {
    assert.equal(resolveExplicitLang('English'), 'en');
    assert.equal(resolveExplicitLang('deutsch'), 'de');
    assert.equal(resolveExplicitLang('中文'), 'zh');
    assert.equal(resolveExplicitLang('invalid'), null);
    assert.equal(normalizeLang('de-AT', 'zh'), 'de');
    assert.match(t('en', 'bot.lang_switched'), /English/);
    assert.match(t('de', 'bot.lang_switched'), /Deutsch/);

    assert.match(formatLlmError({ status: 401 }, 'en'), /Invalid API key/);
    assert.match(formatLlmError({ status: 401 }, 'de'), /Ungültiger API-Schlüssel/);

    const h = createTestHarness({
        UI_LANG: 'en',
        LLM_API_KEY: '',
        DEEPSEEK_API_KEY: 'sk-ds-valid-key-12345'
    });
    try {
        const sender = 'intl@c.us';

        // Default UI_LANG=en
        await h.handler({ from: sender, body: '/help' });
        assert.match(h.replies.at(-1).text, /WhatsApp AI Chat History Assistant/);
        assert.match(h.replies.at(-1).text, /Non-multimodal/);

        // Non-multimodal warning in English
        await h.handler({ from: sender, body: 'Analyze this' });
        assert.match(h.replies[1].text, /Model Notice:.*deepseek-chat.*non-multimodal/);
        assert.match(h.llmCalls[0][0].content, /Respond to the user in English/);

        // Switch sender language to German via /lang de
        await h.handler({ from: sender, body: '/lang de' });
        assert.match(h.replies.at(-1).text, /Deutsch/);
        assert.equal(h.memory.getLang(sender), 'de');

        await h.handler({ from: sender, body: '/help' });
        assert.match(h.replies.at(-1).text, /Chat-Analyse-Assistent/);

        await h.handler({ from: sender, body: '', hasMedia: true, type: 'image', isForwarded: false });
        assert.match(h.replies.at(-1).text, /reines Textmodell/);

        // Invalid /lang shows localized error in German
        await h.handler({ from: sender, body: '/lang fr' });
        assert.match(h.replies.at(-1).text, /Nicht unterstützte Sprache/);
    } finally {
        h.cleanup();
    }
});

test('cli & config: parses/serializes env, formats masked Desktop setup summary, and resolves AUTH_DATA_PATH', () => {
    const raw = '\uFEFF# comment\nUI_LANG=de\nLLM_API_KEY="sk-secret-12345678"\nLLM_MODEL=deepseek-chat\n';
    const parsed = parseEnvText(raw);
    assert.equal(parsed.UI_LANG, 'de');
    assert.equal(parsed.LLM_API_KEY, 'sk-secret-12345678');

    const serialized = serializeEnvMap(parsed);
    assert.match(serialized, /UI_LANG=de/);
    assert.match(serialized, /LLM_MODEL=deepseek-chat/);

    const mmInfo = detectModelMultimodal(parsed.LLM_MODEL, 'auto');
    const summaryDe = buildSetupSummaryText(
        parsed,
        {
            configEnvPath: 'C:\\Desktop\\config.env',
            setupInfoPath: 'C:\\Desktop\\setup-info.txt',
            memoryPath: 'C:\\Desktop\\memory.json',
            recordsGlob: 'C:\\Desktop\\records\\YYYY-MM-DD.md'
        },
        mmInfo,
        'de'
    );
    assert.match(summaryDe, /Desktop-Konfiguration/);
    assert.match(summaryDe, /sk-s\*\*\*\*5678/);
    assert.equal(summaryDe.includes('sk-secret-12345678'), false);

    const cfg = loadConfig({ UI_LANG: 'de', AUTH_DATA_PATH: 'C:\\LocalApp\\wwebjs_auth' });
    assert.equal(cfg.lang, 'de');
    assert.equal(cfg.authDataPath, path.resolve('C:\\LocalApp\\wwebjs_auth'));
});
