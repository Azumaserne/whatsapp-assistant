const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');

const { loadConfig, hasValidApiKey, isSenderAllowed, normalizePhone } = require('../src/config');
const { isChatExportDocument, extractTextFromZipBuffer, truncateChatHistoryTail, parseChatExportMedia } = require('../src/chatExport');
const { ForwardSessionManager } = require('../src/forwardBuffer');
const { MemoryStore } = require('../src/memory');
const { createLlmService, splitLongMessage, formatLlmError } = require('../src/llm');
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
