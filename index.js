const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');

const { loadConfig, hasValidApiKey } = require('./src/config');
const { t, LANG_META } = require('./src/i18n');
const { MemoryStore } = require('./src/memory');
const { ForwardSessionManager } = require('./src/forwardBuffer');
const { createOpenAIClient, createLlmService } = require('./src/llm');
const { createDesktopRecorder } = require('./src/recorder');
const { createMessageHandler, describeMediaType } = require('./src/handler');

function printStartupBanner(config) {
    const lang = config.lang;
    const whitelistText = config.allowedNumbers.size > 0
        ? `${config.allowedNumbers.size}`
        : t(lang, 'cli.val.whitelist_all');
    const forwardModeText = config.forwardAutoAnalyze
        ? t(lang, 'cli.val.fwd_auto', { ms: config.forwardDebounceMs })
        : t(lang, 'cli.val.fwd_manual');
    let multimodalText = t(lang, 'cli.mm.supported');
    if (!config.multimodal.supported) {
        multimodalText = config.multimodal.status === 'unknown'
            ? t(lang, 'cli.mm.unknown')
            : t(lang, 'cli.mm.nonmm');
    }

    console.log('\n============================================================');
    console.log(`  ${t(lang, 'cli.title')}`);
    console.log(`  ${t(lang, 'cli.subtitle')}`);
    console.log('============================================================');
    console.log(`• ${t(lang, 'cli.summary_lang').padEnd(10)} : ${LANG_META[lang].nativeName} (${lang})`);
    console.log(`• ${t(lang, 'cli.summary_url').padEnd(10)} : ${config.baseUrl}`);
    console.log(`• ${t(lang, 'cli.summary_model').padEnd(10)} : ${config.model}`);
    console.log(`• ${t(lang, 'cli.summary_mm').padEnd(10)} : ${multimodalText}`);
    console.log(`• ${t(lang, 'cli.summary_fwd').padEnd(10)} : ${forwardModeText}`);
    console.log(`• ${t(lang, 'cli.summary_selfchat').padEnd(10)} : ${t(lang, config.enableSelfChat ? 'cli.val.enabled' : 'cli.val.disabled')}`);
    console.log(`• ${t(lang, 'cli.summary_whitelist').padEnd(10)} : ${whitelistText}`);
    console.log(`• ${t(lang, 'cli.summary_desktop').padEnd(10)} : ${config.dataDir}`);
    if (config.recordsDir) {
        console.log(`• Records    : ${config.recordsDir}`);
    }
    console.log('------------------------------------------------------------');
    console.log(t(lang, 'cli.disclaimer_1'));
    console.log(t(lang, 'cli.disclaimer_2'));
    console.log(t(lang, 'cli.disclaimer_3'));
    console.log('============================================================\n');

    if (!config.multimodal.supported) {
        const noticeKey = config.multimodal.status === 'unknown' ? 'cli.notice.mm_unknown' : 'cli.notice.mm_nonmm';
        console.warn(`${t(lang, noticeKey, { model: config.model })}\n`);
    }

    if (!hasValidApiKey(config)) {
        console.warn(`${t(lang, 'bot.missing_key')}\n`);
    }
}

/**
 * Start the WhatsApp Web assistant client and listen for incoming messages.
 * @param {{ baseDir?: string, exitOnShutdown?: boolean }} [options]
 */
async function startAssistant(options = {}) {
    const baseDir = options.baseDir || __dirname;
    const exitOnShutdown = options.exitOnShutdown !== false;

    if (process.env.ENV_FILE && fs.existsSync(process.env.ENV_FILE)) {
        dotenv.config({ path: process.env.ENV_FILE, override: true });
    } else {
        dotenv.config({ path: path.join(baseDir, '.env') });
    }

    // Must be set before requiring whatsapp-web.js / puppeteer
    process.env.PUPPETEER_CACHE_DIR =
        process.env.PUPPETEER_CACHE_DIR || path.join(baseDir, '.puppeteer-cache');

    const { Client, LocalAuth } = require('whatsapp-web.js');
    const qrcode = require('qrcode-terminal');

    const config = loadConfig(process.env, baseDir);
    printStartupBanner(config);

    const memory = new MemoryStore({
        filePath: config.memoryFile,
        maxHistory: config.maxHistory
    });

    const forwardManager = new ForwardSessionManager({
        debounceMs: config.forwardDebounceMs,
        autoAnalyze: config.forwardAutoAnalyze
    });

    const recorder = createDesktopRecorder({
        recordsDir: config.recordsDir,
        onSaved: (filePath) => {
            console.log(`💾 ${filePath}`);
        }
    });

    const openaiClient = createOpenAIClient(config);
    const llm = createLlmService({
        client: openaiClient,
        model: config.model,
        temperature: config.temperature,
        maxTokens: config.maxTokens
    });

    const authOptions = config.authDataPath ? { dataPath: config.authDataPath } : undefined;
    const client = new Client({
        authStrategy: new LocalAuth(authOptions),
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
        recorder,
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
        console.log(t(config.lang, 'cli.qr_banner'));
        console.log('========================================\n');
        qrcode.generate(qr, { small: true });
        console.log(`\n${t(config.lang, 'cli.qr_hint')}\n`);
    });

    client.on('ready', () => {
        console.log(t(config.lang, 'cli.ready'));
    });

    client.on('auth_failure', (msg) => {
        console.error(t(config.lang, 'cli.auth_failure'), msg);
    });

    client.on('disconnected', (reason) => {
        console.warn(t(config.lang, 'cli.disconnected'), reason);
    });

    const eventName = config.enableSelfChat ? 'message_create' : 'message';
    client.on(eventName, async (rawMsg) => {
        try {
            const adapted = await adaptWhatsAppMessage(rawMsg);
            await handleIncomingMessage(adapted);
        } catch (error) {
            console.error('Error handling incoming message:', error);
        }
    });

    let shuttingDown = false;
    const shutdownPromise = new Promise((resolve) => {
        async function shutdown(signal) {
            if (shuttingDown) return;
            shuttingDown = true;
            console.log(`\n${t(config.lang, 'cli.shutdown', { signal })}`);
            forwardManager.dispose();
            try {
                await client.destroy();
            } catch {
                // Ignore cleanup errors on exit
            }
            resolve();
            if (exitOnShutdown) {
                process.exit(0);
            }
        }

        process.on('SIGINT', () => shutdown('SIGINT'));
        process.on('SIGTERM', () => shutdown('SIGTERM'));
    });

    await client.initialize();
    return shutdownPromise;
}

if (require.main === module) {
    startAssistant().catch((error) => {
        console.error('❌ Fatal startup error:', error);
        process.exit(1);
    });
}

module.exports = {
    startAssistant
};
