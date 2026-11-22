const { hasValidApiKey, isSenderAllowed } = require('./config');
const { isChatExportDocument, parseChatExportMedia } = require('./chatExport');
const { SUPPORTED_LANGS, LANG_META, resolveExplicitLang, t } = require('./i18n');
const {
    MODE_NAMES,
    getModeDetails,
    buildSystemPrompt,
    buildForwardedAnalysisPrompt,
    buildExportedChatPrompt,
    buildNonMultimodalWarning,
    buildHelpText
} = require('./prompts');
const { splitLongMessage, formatLlmError } = require('./llm');

const MAX_TRACKED_SENT_IDS = 500;

/**
 * Map WhatsApp message types to readable transcript tags.
 * @param {string|null|undefined} msgType
 * @param {string|null|undefined} [filename]
 * @returns {string|null}
 */
function describeMediaType(msgType, filename = null) {
    switch (msgType) {
        case 'image':
            return '[图片]';
        case 'video':
            return '[视频]';
        case 'ptt':
        case 'audio':
            return '[语音]';
        case 'sticker':
            return '[贴纸]';
        case 'document':
            return filename ? `[文件: ${filename}]` : '[文件]';
        case 'location':
            return '[位置]';
        case 'vcard':
        case 'multi_vcard':
            return '[名片]';
        default:
            return null;
    }
}

function getRandomDelayMs(minMs, maxMs) {
    if (maxMs <= 0) return 0;
    if (maxMs <= minMs) return minMs;
    return Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
}

/**
 * Create the WhatsApp incoming message handler with injected transport & services.
 */
function createMessageHandler({
    config,
    llm,
    memory,
    forwardManager,
    recorder = null,
    sendReply,
    setTyping = async () => {},
    clearTyping = async () => {},
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    logger = console
}) {
    /** @type {Map<string, Promise<void>>} */
    const senderQueues = new Map();
    /** @type {Set<string>} */
    const sentMessageIds = new Set();
    /** @type {Set<string>} */
    const warnedNonMultimodalSenders = new Set();

    function getActiveLang(sender) {
        if (memory && typeof memory.getLang === 'function') {
            return memory.getLang(sender) || config.lang || 'zh';
        }
        return config.lang || 'zh';
    }

    function trackSentMessageId(msgId) {
        if (!msgId) return;
        sentMessageIds.add(msgId);
        if (sentMessageIds.size > MAX_TRACKED_SENT_IDS) {
            const oldest = sentMessageIds.values().next().value;
            sentMessageIds.delete(oldest);
        }
    }

    function enqueueForSender(sender, task) {
        const previous = senderQueues.get(sender) || Promise.resolve();
        const next = previous
            .catch(() => {})
            .then(task)
            .catch((error) => {
                logger.error(`Error handling sender ${sender}:`, error);
            })
            .finally(() => {
                if (senderQueues.get(sender) === next) {
                    senderQueues.delete(sender);
                }
            });
        senderQueues.set(sender, next);
        return next;
    }

    async function deliverReply(sender, rawText, { applyDelay = true } = {}) {
        const text = String(rawText || '').trim();
        if (!text) return;

        if (applyDelay) {
            const delayMs = getRandomDelayMs(config.replyDelayMinMs, config.replyDelayMaxMs);
            if (delayMs > 0) {
                await sleep(delayMs);
            }
        }

        const chunks = splitLongMessage(text);
        for (const chunk of chunks) {
            const payload = config.enableSelfChat && config.selfChatReplyPrefix
                ? `${config.selfChatReplyPrefix}${chunk}`
                : chunk;
            const sentId = await sendReply(sender, payload);
            if (sentId) {
                trackSentMessageId(sentId);
            }
        }
    }

    async function resolveQuotedBody(msg) {
        if (!msg.hasQuotedMsg) return null;
        if (typeof msg.quotedBody === 'string' && msg.quotedBody.trim()) {
            return msg.quotedBody.trim();
        }
        if (typeof msg.getQuotedMessage === 'function') {
            try {
                const quoted = await msg.getQuotedMessage();
                const body = quoted && typeof quoted.body === 'string' ? quoted.body.trim() : '';
                return body || describeMediaType(quoted?.type, quoted?.filename);
            } catch {
                return null;
            }
        }
        return null;
    }

    async function ensureApiKeyReady(sender) {
        if (hasValidApiKey(config)) return true;
        const lang = getActiveLang(sender);
        await deliverReply(sender, t(lang, 'bot.missing_key'), { applyDelay: false });
        return false;
    }

    async function maybeSendNonMultimodalWarning(sender, reason = 'initial') {
        if (config.multimodal?.supported) return;
        if (reason === 'initial' && warnedNonMultimodalSenders.has(sender)) return;

        const lang = getActiveLang(sender);
        const warning = buildNonMultimodalWarning(config, reason, lang);
        if (!warning) return;

        warnedNonMultimodalSenders.add(sender);
        await deliverReply(sender, warning, { applyDelay: false });
    }

    async function tryDownloadImageDataUrl(msg) {
        if (!config.multimodal?.supported || !msg.hasMedia || msg.type !== 'image') {
            return null;
        }
        if (typeof msg.downloadMedia !== 'function') {
            return null;
        }

        try {
            const media = await msg.downloadMedia();
            const mime = String(media?.mimetype || '').trim().toLowerCase().split(';')[0];
            if (!media?.data || !mime.startsWith('image/')) {
                return null;
            }
            const byteLen = Buffer.byteLength(media.data, 'base64');
            const maxBytes = config.maxImageBytes || 5 * 1024 * 1024;
            if (byteLen > maxBytes) {
                return null;
            }
            return `data:${mime};base64,${media.data}`;
        } catch (error) {
            logger.error('Failed to download image attachment; falling back to text:', error);
            return null;
        }
    }

    async function runLlmTurn(sender, userPromptText, { imageDataUrls = [], preWarningReason = 'initial', recordKind = 'chat' } = {}) {
        if (!(await ensureApiKeyReady(sender))) return;

        await maybeSendNonMultimodalWarning(sender, preWarningReason);

        const lang = getActiveLang(sender);
        const mode = memory.getMode(sender);
        const systemPrompt = buildSystemPrompt(config.promptFile, mode, lang);
        const history = memory.getMessages(sender);
        const maxImages = config.maxImagesPerBatch || 4;
        const validImages = config.multimodal?.supported
            ? imageDataUrls.filter(Boolean).slice(0, maxImages)
            : [];

        const userContent = validImages.length > 0
            ? [
                { type: 'text', text: userPromptText },
                ...validImages.map((url) => ({
                    type: 'image_url',
                    image_url: { url }
                }))
            ]
            : userPromptText;

        const messages = [
            { role: 'system', content: systemPrompt },
            ...history,
            { role: 'user', content: userContent }
        ];

        try {
            await setTyping(sender);
            const replyText = await llm.complete(messages);
            await clearTyping(sender);
            await deliverReply(sender, replyText, { applyDelay: true });
            memory.appendTurn(sender, userPromptText, replyText);
            if (recorder && typeof recorder.record === 'function') {
                try {
                    recorder.record({
                        sender,
                        kind: recordKind,
                        mode,
                        model: config.model,
                        lang,
                        inputText: userPromptText,
                        replyText
                    });
                } catch (recError) {
                    logger.error('Failed to record analysis history:', recError);
                }
            }
        } catch (error) {
            await clearTyping(sender);
            logger.error('LLM request failed:', error);
            await deliverReply(sender, formatLlmError(error, lang), { applyDelay: false });
        }
    }

    async function analyzeBufferedForwards(sender, question = '', { exitCollectMode = false } = {}) {
        const items = forwardManager.consume(sender, { exitCollectMode });
        if (items.length === 0) return false;

        const lang = getActiveLang(sender);
        const mode = memory.getMode(sender);
        const transcript = forwardManager.formatItems(items);
        const prompt = buildForwardedAnalysisPrompt(transcript, question, mode, lang);
        const hasMediaItems = items.some((it) => Boolean(it.mediaType));
        const maxImages = config.maxImagesPerBatch || 4;
        const imageDataUrls = items
            .map((it) => it.imageDataUrl)
            .filter(Boolean)
            .slice(0, maxImages);

        await runLlmTurn(sender, prompt, {
            imageDataUrls,
            preWarningReason: hasMediaItems ? 'forwarded_media' : 'initial',
            recordKind: 'forwarded'
        });
        return true;
    }

    async function handleCommand(sender, rawText) {
        const match = rawText.match(/^\/([a-zA-Z0-9_-]+)(?:\s+([\s\S]*))?$/);
        if (!match) return false;

        const cmd = match[1].toLowerCase();
        const arg = (match[2] || '').trim();
        const lang = getActiveLang(sender);

        switch (cmd) {
            case 'help':
            case 'start': {
                const mode = memory.getMode(sender);
                await deliverReply(sender, buildHelpText(config, mode, lang), { applyDelay: false });
                return true;
            }
            case 'reset': {
                forwardManager.clear(sender, { exitCollectMode: true });
                memory.reset(sender);
                const postResetLang = getActiveLang(sender);
                await deliverReply(sender, t(postResetLang, 'bot.reset_ok'), { applyDelay: false });
                return true;
            }
            case 'clear': {
                const cleared = forwardManager.clear(sender);
                await deliverReply(
                    sender,
                    cleared > 0
                        ? t(lang, 'bot.clear_ok', { count: cleared })
                        : t(lang, 'bot.clear_empty'),
                    { applyDelay: false }
                );
                return true;
            }
            case 'buffer': {
                const status = forwardManager.getStatus(sender);
                const lines = [
                    t(lang, 'bot.buffer_count', { count: status.count }),
                    t(lang, status.collectMode ? 'bot.buffer_collect_on' : 'bot.buffer_collect_off')
                ];
                if (status.previews.length > 0) {
                    lines.push('', t(lang, 'bot.buffer_preview_title'));
                    status.previews.forEach((p, idx) => {
                        lines.push(`${idx + 1}. ${p}`);
                    });
                    lines.push('', t(lang, 'bot.buffer_preview_hint'));
                }
                await deliverReply(sender, lines.join('\n'), { applyDelay: false });
                return true;
            }
            case 'collect': {
                const current = forwardManager.getStatus(sender);
                const nextEnabled = !current.collectMode;
                forwardManager.setCollectMode(sender, nextEnabled);
                if (nextEnabled) {
                    await deliverReply(sender, t(lang, 'bot.collect_enabled'), { applyDelay: false });
                } else {
                    const updated = forwardManager.getStatus(sender);
                    const msgKey = updated.count > 0
                        ? 'bot.collect_disabled_with_items'
                        : 'bot.collect_disabled_empty';
                    await deliverReply(sender, t(lang, msgKey, { count: updated.count }), { applyDelay: false });
                }
                return true;
            }
            case 'mode': {
                const currentMode = memory.getMode(sender);
                if (!arg) {
                    const list = MODE_NAMES.map((name) => {
                        const info = getModeDetails(name, lang);
                        const tag = name === currentMode ? t(lang, 'bot.mode_current_tag') : '';
                        return `• \`${name}\` (${info.label}): ${info.description}${tag}`;
                    }).join('\n');
                    await deliverReply(
                        sender,
                        `${t(lang, 'bot.mode_list_title')}\n${list}\n\n${t(lang, 'bot.mode_list_hint')}`,
                        { applyDelay: false }
                    );
                    return true;
                }
                const target = arg.toLowerCase();
                if (!MODE_NAMES.includes(target)) {
                    await deliverReply(
                        sender,
                        t(lang, 'bot.mode_not_found', {
                            arg,
                            modes: MODE_NAMES.map((n) => `\`${n}\``).join(', ')
                        }),
                        { applyDelay: false }
                    );
                    return true;
                }
                memory.setMode(sender, target);
                const info = getModeDetails(target, lang);
                await deliverReply(
                    sender,
                    t(lang, 'bot.mode_switched', {
                        label: info.label,
                        mode: target,
                        desc: info.description
                    }),
                    { applyDelay: false }
                );
                return true;
            }
            case 'lang': {
                if (!arg) {
                    const list = SUPPORTED_LANGS.map((code) => {
                        const meta = LANG_META[code];
                        const tag = code === lang ? t(lang, 'bot.mode_current_tag') : '';
                        return `• \`${code}\` — ${meta.nativeName}${tag}`;
                    }).join('\n');
                    await deliverReply(
                        sender,
                        `${t(lang, 'bot.lang_list_title')}\n${list}\n\n${t(lang, 'bot.lang_list_hint')}`,
                        { applyDelay: false }
                    );
                    return true;
                }
                const targetLang = resolveExplicitLang(arg);
                if (!targetLang) {
                    await deliverReply(sender, t(lang, 'bot.lang_invalid', { arg }), { applyDelay: false });
                    return true;
                }
                if (typeof memory.setLang === 'function') {
                    memory.setLang(sender, targetLang);
                }
                await deliverReply(sender, t(targetLang, 'bot.lang_switched'), { applyDelay: false });
                return true;
            }
            case 'analyze': {
                const status = forwardManager.getStatus(sender);
                if (status.count === 0) {
                    await deliverReply(sender, t(lang, 'bot.analyze_empty'), { applyDelay: false });
                    return true;
                }
                await analyzeBufferedForwards(sender, arg, { exitCollectMode: true });
                return true;
            }
            default: {
                await deliverReply(sender, t(lang, 'bot.unknown_cmd', { cmd }), { applyDelay: false });
                return true;
            }
        }
    }

    async function handleExportDocument(sender, msg, userText) {
        if (typeof msg.downloadMedia !== 'function') {
            return false;
        }

        const lang = getActiveLang(sender);
        let media;
        try {
            media = await msg.downloadMedia();
        } catch (error) {
            logger.error('Failed to download exported chat document:', error);
            await deliverReply(sender, t(lang, 'bot.export_download_fail'), { applyDelay: false });
            return true;
        }

        if (!media) {
            await deliverReply(sender, t(lang, 'bot.export_unavailable'), { applyDelay: false });
            return true;
        }

        const effectiveFilename = media.filename || msg.filename || '';
        const effectiveMime = media.mimetype || msg.mimetype || '';
        if (!isChatExportDocument(effectiveFilename, effectiveMime)) {
            return false;
        }

        let exportResult;
        try {
            exportResult = parseChatExportMedia(
                {
                    data: media.data,
                    filename: effectiveFilename || 'chat-export.txt',
                    mimetype: effectiveMime
                },
                config.maxChatExportChars
            );
        } catch (error) {
            await deliverReply(sender, t(lang, 'bot.export_parse_fail', { msg: error.message }), { applyDelay: false });
            return true;
        }

        const mode = memory.getMode(sender);
        const prompt = buildExportedChatPrompt(exportResult, userText, mode, lang);
        await runLlmTurn(sender, prompt, { recordKind: 'export' });
        return true;
    }

    async function processMessage(msg) {
        if (!msg || !msg.from) return;

        const sender = msg.from;
        if (sender.includes('@g.us') || sender.includes('@broadcast') || msg.isStatus) {
            return;
        }

        const rawBody = typeof msg.body === 'string' ? msg.body : '';
        const userText = rawBody.trim();

        // Self-chat & fromMe handling with loop protection
        const msgId = typeof msg.id === 'string' ? msg.id : msg.id?._serialized;
        if (msg.fromMe) {
            if (!config.enableSelfChat) return;
            if (msg.to && msg.from !== msg.to) return;
            if (msgId && sentMessageIds.has(msgId)) return;
            if (config.selfChatReplyPrefix && rawBody.startsWith(config.selfChatReplyPrefix)) return;
        }

        if (!isSenderAllowed(config, sender, msg.contactNumber || null)) {
            return;
        }

        // 1. Check WhatsApp Export Chat (.txt / .zip) document before forwarding logic
        const mightBeDocument = Boolean(
            msg.hasMedia && (
                msg.type === 'document' ||
                isChatExportDocument(msg.filename, msg.mimetype)
            )
        );
        if (mightBeDocument) {
            const handledAsExport = await handleExportDocument(sender, msg, userText);
            if (handledAsExport) return;
        }

        const lang = getActiveLang(sender);
        const isForwarded = Boolean(msg.isForwarded || (Number(msg.forwardingScore) > 0));
        const quotedText = await resolveQuotedBody(msg);
        const mediaTag = msg.hasMedia
            ? (describeMediaType(msg.type, msg.filename) || '[媒体消息]')
            : describeMediaType(msg.type, msg.filename);

        // 2. Directly forwarded messages are batched/debounced (never treat forwarded text as bot commands)
        if (isForwarded) {
            const imageDataUrl = await tryDownloadImageDataUrl(msg);
            forwardManager.addItem(
                sender,
                {
                    text: userText,
                    timestamp: msg.timestamp ?? null,
                    mediaType: mediaTag,
                    quotedText,
                    imageDataUrl
                },
                {
                    onAutoAnalyze: (targetSender) => {
                        enqueueForSender(targetSender, async () => {
                            await analyzeBufferedForwards(targetSender, '');
                        });
                    },
                    onManualAck: (targetSender, count) => {
                        enqueueForSender(targetSender, async () => {
                            const status = forwardManager.getStatus(targetSender);
                            if (status.count === 0) return;
                            const targetLang = getActiveLang(targetSender);
                            await deliverReply(
                                targetSender,
                                t(targetLang, 'bot.manual_ack', { count }),
                                { applyDelay: false }
                            );
                        });
                    }
                }
            );
            return;
        }

        // 3. Non-forwarded, non-export media without text caption -> warn if non-multimodal or guide user
        if (!userText && msg.hasMedia) {
            if (!config.multimodal?.supported) {
                await maybeSendNonMultimodalWarning(sender, 'media');
                return;
            }
            await deliverReply(sender, t(lang, 'bot.no_screenshot_guide'), { applyDelay: false });
            return;
        }

        if (!userText) return;

        // 4. Slash commands
        if (userText.startsWith('/')) {
            const handled = await handleCommand(sender, userText);
            if (handled) return;
        }

        // 5. Regular text message: check if forwarded messages are waiting in the buffer
        const bufferStatus = forwardManager.getStatus(sender);
        if (bufferStatus.count > 0) {
            if (bufferStatus.collectMode) {
                await deliverReply(
                    sender,
                    t(lang, 'bot.collect_reminder', { count: bufferStatus.count, question: userText }),
                    { applyDelay: false }
                );
                return;
            }
            // Cancel auto-analyze timer and combine pending forwarded chat + user's question into one LLM call
            await analyzeBufferedForwards(sender, userText);
            return;
        }

        // 6. Standard conversational follow-up (with optional quoted context / image attachment)
        const imageDataUrl = await tryDownloadImageDataUrl(msg);
        const promptParts = [];
        if (quotedText) {
            promptParts.push(t(lang, 'bot.quoted_prefix', { quote: quotedText }));
        }
        if (msg.hasMedia && mediaTag && !imageDataUrl) {
            promptParts.push(t(lang, 'bot.media_fallback_note', { mediaTag }));
        }
        promptParts.push(userText);
        const preWarningReason = (msg.hasMedia && !imageDataUrl) ? 'media' : 'initial';
        await runLlmTurn(sender, promptParts.join('\n\n'), {
            imageDataUrls: imageDataUrl ? [imageDataUrl] : [],
            preWarningReason
        });
    }

    /**
     * Public entrypoint invoked per incoming WhatsApp message event.
     * @param {object} msg
     */
    return function handleIncomingMessage(msg) {
        const sender = msg && msg.from ? msg.from : '__unknown__';
        return enqueueForSender(sender, () => processMessage(msg));
    };
}

module.exports = {
    createMessageHandler,
    describeMediaType
};
