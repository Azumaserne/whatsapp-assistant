const path = require('path');
const zlib = require('zlib');

const MAX_UNCOMPRESSED_ZIP_BYTES = 15 * 1024 * 1024;
const ZIP_EOCD_SIG = 0x06054b50;
const ZIP_CD_SIG = 0x02014b50;
const ZIP_LFH_SIG = 0x04034b50;

const TEXT_EXTENSIONS = new Set(['.txt', '.log', '.md', '.csv']);

/**
 * Determine whether an incoming document is a supported WhatsApp chat export (.txt or .zip).
 * @param {string|null|undefined} filename
 * @param {string|null|undefined} mimetype
 * @returns {'zip'|'text'|null}
 */
function isChatExportDocument(filename, mimetype) {
    const ext = filename ? path.extname(String(filename).trim()).toLowerCase() : '';
    const mime = mimetype ? String(mimetype).trim().toLowerCase().split(';')[0] : '';

    if (ext === '.zip' || mime === 'application/zip' || mime === 'application/x-zip-compressed') {
        return 'zip';
    }
    if (TEXT_EXTENSIONS.has(ext) || mime.startsWith('text/')) {
        return 'text';
    }
    return null;
}

/**
 * Extract the chat transcript (.txt) from a WhatsApp Export Chat ZIP buffer using pure Node zlib.
 * Prefers `_chat.txt` (iOS WhatsApp export standard), otherwise picks the largest .txt entry.
 * @param {Buffer} buffer
 * @returns {{ entryName: string, text: string }}
 */
function extractTextFromZipBuffer(buffer) {
    if (!Buffer.isBuffer(buffer) || buffer.length < 22) {
        throw new Error('ZIP 文件无效或内容过短');
    }

    // Locate End of Central Directory (EOCD) scanning backwards within max comment length
    const minOffset = Math.max(0, buffer.length - 65557);
    let eocdOffset = -1;
    for (let i = buffer.length - 22; i >= minOffset; i -= 1) {
        if (buffer.readUInt32LE(i) === ZIP_EOCD_SIG) {
            eocdOffset = i;
            break;
        }
    }

    if (eocdOffset === -1) {
        throw new Error('ZIP 目录结构损坏（未找到 EOCD 标识）');
    }

    const totalEntries = buffer.readUInt16LE(eocdOffset + 10);
    const cdSize = buffer.readUInt32LE(eocdOffset + 12);
    const cdOffset = buffer.readUInt32LE(eocdOffset + 16);

    if (cdOffset + cdSize > buffer.length) {
        throw new Error('ZIP 中央目录越界或文件不完整');
    }

    const candidates = [];
    let cursor = cdOffset;

    for (let idx = 0; idx < totalEntries && cursor + 46 <= cdOffset + cdSize; idx += 1) {
        if (buffer.readUInt32LE(cursor) !== ZIP_CD_SIG) {
            throw new Error('ZIP 中央目录条目损坏');
        }

        const generalFlag = buffer.readUInt16LE(cursor + 8);
        const compressionMethod = buffer.readUInt16LE(cursor + 10);
        const compressedSize = buffer.readUInt32LE(cursor + 20);
        const uncompressedSize = buffer.readUInt32LE(cursor + 24);
        const nameLen = buffer.readUInt16LE(cursor + 28);
        const extraLen = buffer.readUInt16LE(cursor + 30);
        const commentLen = buffer.readUInt16LE(cursor + 32);
        const localHeaderOffset = buffer.readUInt32LE(cursor + 42);

        const nameStart = cursor + 46;
        const nameEnd = nameStart + nameLen;
        if (nameEnd > buffer.length) break;

        const nameFlagsUtf8 = (generalFlag & 0x0800) !== 0;
        const entryName = buffer.toString(nameFlagsUtf8 ? 'utf8' : 'latin1', nameStart, nameEnd);
        cursor = nameEnd + extraLen + commentLen;

        const isDirectory = entryName.endsWith('/');
        const isMacJunk = entryName.startsWith('__MACOSX/') || path.posix.basename(entryName).startsWith('._');
        if (isDirectory || isMacJunk) continue;

        if (entryName.toLowerCase().endsWith('.txt')) {
            candidates.push({
                entryName,
                generalFlag,
                compressionMethod,
                compressedSize,
                uncompressedSize,
                localHeaderOffset
            });
        }
    }

    if (candidates.length === 0) {
        throw new Error('ZIP 压缩包中未找到 .txt 聊天记录文件');
    }

    // Prefer _chat.txt (iOS export), otherwise choose the largest .txt entry
    candidates.sort((a, b) => {
        const aIsChat = path.posix.basename(a.entryName).toLowerCase() === '_chat.txt' ? 1 : 0;
        const bIsChat = path.posix.basename(b.entryName).toLowerCase() === '_chat.txt' ? 1 : 0;
        if (aIsChat !== bIsChat) return bIsChat - aIsChat;
        return b.uncompressedSize - a.uncompressedSize;
    });

    const chosen = candidates[0];

    if ((chosen.generalFlag & 0x0001) !== 0) {
        throw new Error('不支持加密或需要密码的 ZIP 文件');
    }
    if (chosen.uncompressedSize > MAX_UNCOMPRESSED_ZIP_BYTES) {
        throw new Error(`压缩包内的聊天文件过大（超过 ${Math.round(MAX_UNCOMPRESSED_ZIP_BYTES / (1024 * 1024))}MB 上限）`);
    }

    const lfhOffset = chosen.localHeaderOffset;
    if (lfhOffset + 30 > buffer.length || buffer.readUInt32LE(lfhOffset) !== ZIP_LFH_SIG) {
        throw new Error('ZIP 本地文件头损坏');
    }

    const lfhNameLen = buffer.readUInt16LE(lfhOffset + 26);
    const lfhExtraLen = buffer.readUInt16LE(lfhOffset + 28);
    const dataStart = lfhOffset + 30 + lfhNameLen + lfhExtraLen;
    const dataEnd = dataStart + chosen.compressedSize;

    if (dataEnd > buffer.length) {
        throw new Error('ZIP 文件数据截断或损坏');
    }

    const compressedSlice = buffer.subarray(dataStart, dataEnd);
    let rawBuffer;

    if (chosen.compressionMethod === 0) {
        rawBuffer = compressedSlice;
    } else if (chosen.compressionMethod === 8) {
        rawBuffer = zlib.inflateRawSync(compressedSlice, { maxOutputLength: MAX_UNCOMPRESSED_ZIP_BYTES });
    } else {
        throw new Error(`不支持的 ZIP 压缩方式 (method=${chosen.compressionMethod})，请直接发送 .txt 文件`);
    }

    return {
        entryName: chosen.entryName,
        text: rawBuffer.toString('utf-8')
    };
}

/**
 * Normalize line endings/BOM and keep the most recent tail within maxChars.
 * @param {string} rawText
 * @param {number} maxChars
 * @returns {{ text: string, totalChars: number, keptChars: number, truncated: boolean }}
 */
function truncateChatHistoryTail(rawText, maxChars = 60000) {
    const cleaned = String(rawText || '')
        .replace(/^\uFEFF/, '')
        .replace(/\r\n/g, '\n')
        .trim();

    const totalChars = cleaned.length;
    if (totalChars <= maxChars) {
        return {
            text: cleaned,
            totalChars,
            keptChars: totalChars,
            truncated: false
        };
    }

    let tail = cleaned.slice(totalChars - maxChars);
    const firstNewline = tail.indexOf('\n');
    if (firstNewline > 0 && firstNewline < 500) {
        tail = tail.slice(firstNewline + 1);
    }

    return {
        text: tail,
        totalChars,
        keptChars: tail.length,
        truncated: true
    };
}

/**
 * Parse a downloaded WhatsApp MessageMedia document (.txt or .zip) into normalized chat history.
 * @param {{ data: string, filename?: string, mimetype?: string }} media
 * @param {number} [maxChars]
 */
function parseChatExportMedia(media, maxChars = 60000) {
    if (!media || !media.data) {
        throw new Error('未能获取到文件内容，请重新发送');
    }

    const filename = media.filename || 'chat-export';
    const docKind = isChatExportDocument(filename, media.mimetype);
    if (!docKind) {
        throw new Error('仅支持 .txt 文本或 WhatsApp 导出的 .zip 压缩包');
    }

    const buffer = Buffer.from(media.data, 'base64');
    let rawText;
    let entryName = null;

    if (docKind === 'zip') {
        const extracted = extractTextFromZipBuffer(buffer);
        rawText = extracted.text;
        entryName = extracted.entryName;
    } else {
        rawText = buffer.toString('utf-8');
    }

    const truncatedResult = truncateChatHistoryTail(rawText, maxChars);
    if (!truncatedResult.text) {
        throw new Error('聊天记录文件内容为空，无法分析');
    }

    return {
        filename,
        entryName,
        ...truncatedResult
    };
}

module.exports = {
    MAX_UNCOMPRESSED_ZIP_BYTES,
    isChatExportDocument,
    extractTextFromZipBuffer,
    truncateChatHistoryTail,
    parseChatExportMedia
};
