require('dotenv').config();
const path = require('path');

// 让 Puppeteer 使用项目内自带缓存（必须在 require whatsapp-web.js 之前设置）
process.env.PUPPETEER_CACHE_DIR =
    process.env.PUPPETEER_CACHE_DIR || path.join(__dirname, '.puppeteer-cache');

const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');

const { loadConfig, hasValidApiKey } = require('./src/config');
const { MemoryStore } = require('./src/memory');
const { ForwardSessionManager } = require('./src/forwardBuffer');
const { createOpenAIClient, createLlmService } = require('./src/llm');
const { createMessageHandler, describeMediaType } = require('./src/handler');

const config = loadConfig(process.env, __dirname);

function printStartupBanner() {
    const whitelistText = config.allowedNumbers.size > 0
        ? `${config.allowedNumbers.size} 个号码/JID`
        : '未限制（响应所有私聊）';
    const forwardModeText = config.forwardAutoAnalyze
        ? `自动防抖分析 (${config.forwardDebounceMs}ms)`
        : '手动触发 (/analyze)';
    let multimodalText = '✅ 已支持';
    if (!config.multimodal.supported) {
        multimodalText = config.multimodal.status === 'unknown'
            ? '⚠️ 未知（默认纯文本，向用户发送警告；可设 LLM_MULTIMODAL=true）'
            : '⚠️ 非多模态（纯文本，向用户发送警告）';
    }

    console.log('\n============================================================');
    console.log('  WhatsApp AI Assistant  |  by @Azumaserne (MIT License)');
    console.log('============================================================');
    console.log(`• API 地址   : ${config.baseUrl}`);
    console.log(`• 默认模型   : ${config.model}`);
    console.log(`• 多模态支持 : ${multimodalText}`);
    console.log(`• 转发模式   : ${forwardModeText}`);
    console.log(`• 自聊模式   : ${config.enableSelfChat ? '已开启 (Message Yourself)' : '未开启'}`);
    console.log(`• 白名单     : ${whitelistText}`);
    console.log('------------------------------------------------------------');
    console.log('⚠️  重要声明：');
    console.log('   1. 本助手需自备 OpenAI 兼容 API Key（BYO API）。');
    console.log('   2. 基于非官方 whatsapp-web.js，存在封号/风控风险，');
    console.log('      封号概不负责，强烈建议使用独立小号运行！');
    console.log('============================================================\n');

    if (!config.multimodal.supported) {
        console.warn(`⚠️  当前模型 "${config.model}" ${config.multimodal.status === 'unknown' ? '未确认支持多模态' : '为非多模态（纯文本）模型'}，助手会在 WhatsApp 对话中向用户发送提醒/警告。\n`);
    }

    if (!hasValidApiKey(config)) {
        console.warn('⚠️  未检测到有效的 API Key，请先在 .env 中填写 LLM_API_KEY（或 DEEPSEEK_API_KEY）。\n');
    }
}

printStartupBanner();

const memory = new MemoryStore({
    filePath: config.memoryFile,
    maxHistory: config.maxHistory
});

const forwardManager = new ForwardSessionManager({
    debounceMs: config.forwardDebounceMs,
    autoAnalyze: config.forwardAutoAnalyze
});

const openaiClient = createOpenAIClient(config);
const llm = createLlmService({
    client: openaiClient,
    model: config.model,
    temperature: config.temperature,
    maxTokens: config.maxTokens
});

const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: {
        executablePath: config.chromePath,
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    }
});

async function adaptWhatsAppMessage(rawMsg) {
    let contactNumber = null;
    if (config.allowedNumbers.size > 0 && typeof rawMsg.getContact === 'function') {
        try {
            const contact = await rawMsg.getContact();
            contactNumber = contact?.number || null;
        } catch {
            contactNumber = null;
        }
    }

    let quotedBody = null;
    if (rawMsg.hasQuotedMsg && typeof rawMsg.getQuotedMessage === 'function') {
        try {
            const quoted = await rawMsg.getQuotedMessage();
            const qText = quoted && typeof quoted.body === 'string' ? quoted.body.trim() : '';
            quotedBody = qText || describeMediaType(quoted?.type, quoted?._data?.filename);
        } catch {
            quotedBody = null;
        }
    }

    return {
        id: rawMsg.id?._serialized || rawMsg.id || null,
        from: rawMsg.from,
        to: rawMsg.to,
        body: rawMsg.body || '',
        timestamp: rawMsg.timestamp ?? null,
        type: rawMsg.type || 'chat',
        fromMe: Boolean(rawMsg.fromMe),
        isStatus: Boolean(rawMsg.isStatus),
        isForwarded: Boolean(rawMsg.isForwarded),
        forwardingScore: Number(rawMsg.forwardingScore || 0),
        hasMedia: Boolean(rawMsg.hasMedia),
        hasQuotedMsg: Boolean(rawMsg.hasQuotedMsg),
        quotedBody,
        contactNumber,
        filename: rawMsg._data?.filename || rawMsg.filename || null,
        mimetype: rawMsg._data?.mimetype || rawMsg.mimetype || null,
        downloadMedia: typeof rawMsg.downloadMedia === 'function'
            ? () => rawMsg.downloadMedia()
            : undefined
    };
}

const handleIncomingMessage = createMessageHandler({
    config,
    llm,
    memory,
    forwardManager,
    sendReply: async (sender, text) => {
        const sent = await client.sendMessage(sender, text);
        return sent?.id?._serialized || null;
    },
    setTyping: async (sender) => {
        try {
            const chat = await client.getChatById(sender);
            await chat.sendStateTyping();
        } catch {
            // Ignore typing state failures
        }
    },
    clearTyping: async (sender) => {
        try {
            const chat = await client.getChatById(sender);
            await chat.clearState();
        } catch {
            // Ignore typing state failures
        }
    }
});

client.on('qr', (qr) => {
    console.log('\n========================================');
    console.log('请使用作为助手的【WhatsApp 小号】扫描下方二维码登录：');
    console.log('========================================\n');
    qrcode.generate(qr, { small: true });
});

client.on('ready', () => {
    console.log('✅ WhatsApp AI 助手已成功上线！直接转发聊天记录或发送 .txt/.zip 即可分析。');
});

client.on('auth_failure', (msg) => {
    console.error('❌ WhatsApp 认证失败:', msg);
});

client.on('disconnected', (reason) => {
    console.warn('⚠️  WhatsApp 连接已断开:', reason);
});

const eventName = config.enableSelfChat ? 'message_create' : 'message';
client.on(eventName, async (rawMsg) => {
    try {
        const adapted = await adaptWhatsAppMessage(rawMsg);
        await handleIncomingMessage(adapted);
    } catch (error) {
        console.error('❌ 处理消息异常:', error);
    }
});

let shuttingDown = false;
async function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n收到 ${signal}，正在安全关闭 WhatsApp 助手...`);
    forwardManager.dispose();
    try {
        await client.destroy();
    } catch {
        // Ignore cleanup errors on exit
    }
    process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

client.initialize();
