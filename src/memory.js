const fs = require('fs');
const path = require('path');
const { resolveExplicitLang } = require('./i18n');

const VALID_ROLES = new Set(['user', 'assistant']);

/**
 * Per-sender persistent conversation store with migration from legacy whatsapp-lover array memory.
 */
class MemoryStore {
    /**
     * @param {{ filePath?: string|null, maxHistory?: number, logger?: Console }} [options]
     */
    constructor({ filePath = null, maxHistory = 24, logger = console } = {}) {
        this.filePath = filePath;
        this.maxHistory = maxHistory;
        this.logger = logger;
        this.data = this._load();
    }

    _normalizeEntry(rawEntry) {
        // Legacy whatsapp-lover stored raw array: [{ role: 'system'|'user'|'assistant', content }]
        if (Array.isArray(rawEntry)) {
            const messages = rawEntry
                .filter((m) => m && VALID_ROLES.has(m.role) && typeof m.content === 'string')
                .map((m) => ({ role: m.role, content: m.content }));
            return {
                mode: 'general',
                lang: null,
                messages: messages.slice(-this.maxHistory)
            };
        }

        if (rawEntry && typeof rawEntry === 'object') {
            const messages = Array.isArray(rawEntry.messages)
                ? rawEntry.messages
                    .filter((m) => m && VALID_ROLES.has(m.role) && typeof m.content === 'string')
                    .map((m) => ({ role: m.role, content: m.content }))
                    .slice(-this.maxHistory)
                : [];
            return {
                mode: typeof rawEntry.mode === 'string' && rawEntry.mode ? rawEntry.mode : 'general',
                lang: resolveExplicitLang(rawEntry.lang),
                messages
            };
        }

        return { mode: 'general', lang: null, messages: [] };
    }

    _load() {
        if (!this.filePath || !fs.existsSync(this.filePath)) {
            return {};
        }

        try {
            const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf-8'));
            if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
                return {};
            }
            const normalized = {};
            for (const [sender, entry] of Object.entries(parsed)) {
                normalized[sender] = this._normalizeEntry(entry);
            }
            return normalized;
        } catch (error) {
            this.logger.error('读取 memory.json 失败，已重置记忆:', error.message);
            return {};
        }
    }

    _ensureSender(sender) {
        if (!this.data[sender]) {
            this.data[sender] = { mode: 'general', lang: null, messages: [] };
        }
        return this.data[sender];
    }

    getMode(sender) {
        return this._ensureSender(sender).mode;
    }

    setMode(sender, mode) {
        const entry = this._ensureSender(sender);
        entry.mode = mode;
        this.save();
        return entry.mode;
    }

    getLang(sender) {
        return this._ensureSender(sender).lang || null;
    }

    setLang(sender, lang) {
        const entry = this._ensureSender(sender);
        entry.lang = resolveExplicitLang(lang);
        this.save();
        return entry.lang;
    }

    getMessages(sender) {
        return this._ensureSender(sender).messages.slice();
    }

    appendTurn(sender, userContent, assistantContent) {
        const entry = this._ensureSender(sender);
        entry.messages.push(
            { role: 'user', content: String(userContent) },
            { role: 'assistant', content: String(assistantContent) }
        );
        if (entry.messages.length > this.maxHistory) {
            entry.messages.splice(0, entry.messages.length - this.maxHistory);
        }
        this.save();
    }

    reset(sender) {
        this.data[sender] = { mode: 'general', lang: null, messages: [] };
        this.save();
    }

    save() {
        if (!this.filePath) return;
        fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
        fs.writeFileSync(this.filePath, JSON.stringify(this.data, null, 2), 'utf-8');
    }
}

module.exports = {
    MemoryStore
};
