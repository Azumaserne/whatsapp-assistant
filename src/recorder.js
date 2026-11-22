const fs = require('fs');
const path = require('path');

const KIND_LABELS = {
    forwarded: '转发聊天记录分析',
    export: '导出聊天文件分析',
    chat: '常规对话'
};

/**
 * Format a Date object as local YYYY-MM-DD for daily Markdown record filenames.
 * @param {Date} [date]
 * @returns {string}
 */
function formatDateKey(date = new Date()) {
    const d = date instanceof Date && !Number.isNaN(date.getTime()) ? date : new Date();
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return `${yyyy}-${mm}-${dd}`;
}

function formatDateTime(date = new Date()) {
    const d = date instanceof Date && !Number.isNaN(date.getTime()) ? date : new Date();
    const datePart = formatDateKey(d);
    const hh = String(d.getHours()).padStart(2, '0');
    const mi = String(d.getMinutes()).padStart(2, '0');
    const ss = String(d.getSeconds()).padStart(2, '0');
    return `${datePart} ${hh}:${mi}:${ss}`;
}

/**
 * Create a Markdown chat-analysis recorder targeting a Desktop/data directory.
 * @param {{ recordsDir?: string|null, logger?: Console, onSaved?: (filePath: string) => void }} [options]
 */
function createDesktopRecorder({ recordsDir = null, logger = console, onSaved = null } = {}) {
    if (!recordsDir) {
        return {
            record: () => null
        };
    }

    return {
        record({
            sender = '',
            kind = 'chat',
            mode = 'general',
            model = '',
            inputText = '',
            replyText = '',
            timestamp = new Date()
        } = {}) {
            try {
                fs.mkdirSync(recordsDir, { recursive: true });
                const ts = timestamp instanceof Date ? timestamp : new Date(timestamp);
                const dateKey = formatDateKey(ts);
                const timeStr = formatDateTime(ts);
                const kindLabel = KIND_LABELS[kind] || KIND_LABELS.chat;
                const filePath = path.join(recordsDir, `${dateKey}.md`);

                const needsHeader = !fs.existsSync(filePath);
                const sections = [];
                if (needsHeader) {
                    sections.push(`# WhatsApp AI Assistant 分析记录（${dateKey}）\n`);
                }
                sections.push(
                    `## [${timeStr}] ${kindLabel}`,
                    '',
                    `- **联系人**: \`${sender || 'unknown'}\``,
                    `- **分析模式**: \`${mode}\``,
                    `- **使用模型**: \`${model || 'unknown'}\``,
                    '',
                    '### 📥 原始输入 / 聊天记录',
                    String(inputText || '').trim(),
                    '',
                    '### 🤖 AI 分析结果',
                    String(replyText || '').trim(),
                    '',
                    '---',
                    '',
                    ''
                );

                fs.appendFileSync(filePath, sections.join('\n'), 'utf-8');
                if (typeof onSaved === 'function') {
                    onSaved(filePath);
                }
                return filePath;
            } catch (error) {
                logger.error('保存桌面分析记录失败:', error);
                return null;
            }
        }
    };
}

module.exports = {
    createDesktopRecorder,
    formatDateKey
};
