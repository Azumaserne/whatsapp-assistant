const { hasValidApiKey, isSenderAllowed } = require('./config');
const { isChatExportDocument, parseChatExportMedia } = require('./chatExport');
const {
    ANALYSIS_MODES,
    MODE_NAMES,
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
                logger.error(`处理联系人 ${sender} 任务异常:`, error);
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
        await deliverReply(
            sender,
            '⚠️ 助手尚未配置有效的 API Key。请先在项目 `.env` 文件中填写 `LLM_API_KEY`（自备 API）并重启程序。',
            { applyDelay: false }
        );
        return false;
    }

    async function maybeSendNonMultimodalWarning(sender, reason = 'initial') {
        if (config.multimodal?.supported) return;
        if (reason === 'initial' && warnedNonMultimodalSenders.has(sender)) return;

        const warning = buildNonMultimodalWarning(config, reason);
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
            logger.error('下载图片失败，已回退为文本分析:', error);
            return null;
        }
    }

    async function runLlmTurn(sender, userPromptText, { imageDataUrls = [], preWarningReason = 'initial', recordKind = 'chat' } = {}) {
        if (!(await ensureApiKeyReady(sender))) return;

        await maybeSendNonMultimodalWarning(sender, preWarningReason);

        const mode = memory.getMode(sender);
        const systemPrompt = buildSystemPrompt(config.promptFile, mode);
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
                        inputText: userPromptText,
                        replyText
                    });
                } catch (recError) {
                    logger.error('记录分析历史失败:', recError);
                }
            }
        } catch (error) {
            await clearTyping(sender);
            logger.error('LLM 调用失败:', error);
            await deliverReply(sender, formatLlmError(error), { applyDelay: false });
        }
    }

    async function analyzeBufferedForwards(sender, question = '', { exitCollectMode = false } = {}) {
        const items = forwardManager.consume(sender, { exitCollectMode });
        if (items.length === 0) return false;

        const mode = memory.getMode(sender);
        const transcript = forwardManager.formatItems(items);
        const prompt = buildForwardedAnalysisPrompt(transcript, question, mode);
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

        switch (cmd) {
            case 'help':
            case 'start': {
                const mode = memory.getMode(sender);
                await deliverReply(sender, buildHelpText(config, mode), { applyDelay: false });
                return true;
            }
            case 'reset': {
                forwardManager.clear(sender, { exitCollectMode: true });
                memory.reset(sender);
                await deliverReply(
                    sender,
                    '✅ 已清空当前会话记忆与转发暂存区，并重新加载最新 `prompt.txt`（模式已恢复为 `general`）。',
                    { applyDelay: false }
                );
                return true;
            }
            case 'clear': {
                const cleared = forwardManager.clear(sender);
                await deliverReply(
                    sender,
                    cleared > 0
                        ? `🗑️ 已清空转发暂存区中的 ${cleared} 条记录。`
                        : 'ℹ️ 当前转发暂存区本来就是空的。',
                    { applyDelay: false }
                );
                return true;
            }
            case 'buffer': {
                const status = forwardManager.getStatus(sender);
                const lines = [
                    `📥 当前暂存区：共 *${status.count}* 条转发记录`,
                    `📦 收集模式（/collect）：${status.collectMode ? '已开启' : '未开启'}`
                ];
                if (status.previews.length > 0) {
                    lines.push('', '最近几条预览：');
                    status.previews.forEach((p, idx) => {
                        lines.push(`${idx + 1}. ${p}`);
                    });
                    lines.push('', '发送 `/analyze [你的问题]` 即可立即分析，或 `/clear` 清空。');
                }
                await deliverReply(sender, lines.join('\n'), { applyDelay: false });
                return true;
            }
            case 'collect': {
                const current = forwardManager.getStatus(sender);
                const nextEnabled = !current.collectMode;
                forwardManager.setCollectMode(sender, nextEnabled);
                if (nextEnabled) {
                    await deliverReply(
                        sender,
                        '📦 已开启【手动收集模式】。现在可以分多批转发来自不同聊天的记录，全部转完后发送 `/analyze [你的问题]` 开始分析。',
                        { applyDelay: false }
                    );
                } else {
                    const updated = forwardManager.getStatus(sender);
                    const tailHint = updated.count > 0
                        ? `当前已暂存 ${updated.count} 条记录，可直接发送问题或 \`/analyze\` 开始分析。`
                        : '已恢复常规自动响应模式。';
                    await deliverReply(sender, `📦 已退出【手动收集模式】。${tailHint}`, { applyDelay: false });
                }
                return true;
            }
            case 'mode': {
                const currentMode = memory.getMode(sender);
                if (!arg) {
                    const list = MODE_NAMES.map((name) => {
                        const info = ANALYSIS_MODES[name];
                        const tag = name === currentMode ? ' ✅ 当前' : '';
                        return `• \`${name}\`（${info.label}）：${info.description}${tag}`;
                    }).join('\n');
                    await deliverReply(
                        sender,
                        `*分析模式列表：*\n${list}\n\n发送 \`/mode 模式名\` 即可切换（例如 \`/mode reply\`）。`,
                        { applyDelay: false }
                    );
                    return true;
                }
                const target = arg.toLowerCase();
                if (!ANALYSIS_MODES[target]) {
                    await deliverReply(
                        sender,
                        `⚠️ 未找到模式 \`${arg}\`。可选模式：${MODE_NAMES.map((n) => `\`${n}\``).join('、')}`,
                        { applyDelay: false }
                    );
                    return true;
                }
                memory.setMode(sender, target);
                const info = ANALYSIS_MODES[target];
                await deliverReply(
                    sender,
                    `✅ 已切换分析模式为 *${info.label}*（\`${target}\`）：${info.description}`,
                    { applyDelay: false }
                );
                return true;
            }
            case 'analyze': {
                const status = forwardManager.getStatus(sender);
                if (status.count === 0) {
                    await deliverReply(
                        sender,
                        'ℹ️ 当前没有待分析的转发聊天记录。请先从其他对话长按多选转发消息过来，或直接发送 WhatsApp 导出的 `.txt` / `.zip` 文件。',
                        { applyDelay: false }
                    );
                    return true;
                }
                await analyzeBufferedForwards(sender, arg, { exitCollectMode: true });
                return true;
            }
            default: {
                await deliverReply(
                    sender,
                    `ℹ️ 未识别的指令 \`/${cmd}\`，发送 \`/help\` 查看全部可用指令。`,
                    { applyDelay: false }
                );
                return true;
            }
        }
    }

    async function handleExportDocument(sender, msg, userText) {
        if (typeof msg.downloadMedia !== 'function') {
            return false;
        }

        let media;
        try {
            media = await msg.downloadMedia();
        } catch (error) {
            logger.error('下载导出文件失败:', error);
            await deliverReply(sender, '❌ 下载聊天记录文件失败，请重新发送一次。', { applyDelay: false });
            return true;
        }

        if (!media) {
            await deliverReply(sender, '❌ 未能获取该文件内容（可能已过期），请重新发送。', { applyDelay: false });
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
            await deliverReply(sender, `❌ 无法解析聊天记录文件：${error.message}`, { applyDelay: false });
            return true;
        }

        const mode = memory.getMode(sender);
        const prompt = buildExportedChatPrompt(exportResult, userText, mode);
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
                            await deliverReply(
                                targetSender,
                                `📥 已暂存 ${count} 条转发记录，请直接发送你的问题，或发送 \`/analyze\` 开始分析。`,
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
            await deliverReply(
                sender,
                '💡 不需要发截图哦！你可以直接在原对话里长按多选消息并*转发*给我，或者在对话右上角使用「导出聊天记录 (.txt / .zip)」直接发过来，我就能立刻帮你分析。',
                { applyDelay: false }
            );
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
                    `📦 当前处于手动收集模式，已暂存 *${bufferStatus.count}* 条记录。发送 \`/analyze ${userText}\` 可带着这个问题一起分析，或先发送 \`/collect\` 退出收集模式。`,
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
            promptParts.push(`[引用消息：${quotedText}]`);
        }
        if (msg.hasMedia && mediaTag && !imageDataUrl) {
            promptParts.push(`[系统提示：用户附带了一个 ${mediaTag}，但当前未能读取图片/媒体内容；若对方是在发聊天截图，请温和提醒无需截图，直接多选转发原聊天记录或导出 .txt/.zip 文件即可]`);
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
