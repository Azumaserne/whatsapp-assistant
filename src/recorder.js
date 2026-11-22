const fs = require('fs');
const path = require('path');
const { normalizeLang, t } = require('./i18n');

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
            lang = 'zh',
            inputText = '',
            replyText = '',
            timestamp = new Date()
        } = {}) {
            try {
                fs.mkdirSync(recordsDir, { recursive: true });
                const activeLang = normalizeLang(lang, 'zh');
                const ts = timestamp instanceof Date ? timestamp : new Date(timestamp);
                const dateKey = formatDateKey(ts);
                const timeStr = formatDateTime(ts);
                const kindKey = ['forwarded', 'export', 'chat'].includes(kind) ? `rec.kind.${kind}` : 'rec.kind.chat';
                const kindLabel = t(activeLang, kindKey);
                const filePath = path.join(recordsDir, `${dateKey}.md`);

                const needsHeader = !fs.existsSync(filePath);
                const sections = [];
                if (needsHeader) {
                    sections.push(`${t(activeLang, 'rec.title', { date: dateKey })}\n`);
                }
                sections.push(
                    `## [${timeStr}] ${kindLabel}`,
                    '',
                    `- **${t(activeLang, 'rec.sender')}**: \`${sender || 'unknown'}\``,
                    `- **${t(activeLang, 'rec.mode')}**: \`${mode}\``,
                    `- **${t(activeLang, 'rec.model')}**: \`${model || 'unknown'}\``,
                    '',
                    t(activeLang, 'rec.input'),
                    String(inputText || '').trim(),
                    '',
                    t(activeLang, 'rec.output'),
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
                logger.error('Failed to save Desktop analysis record:', error);
                return null;
            }
        }
    };
}

module.exports = {
    createDesktopRecorder,
    formatDateKey
};
