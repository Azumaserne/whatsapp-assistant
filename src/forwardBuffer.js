/**
 * Format an optional timestamp (string or Unix seconds/ms) as HH:MM.
 * @param {string|number|null|undefined} ts
 * @returns {string|null}
 */
function formatTimestamp(ts) {
    if (ts === null || ts === undefined || ts === '') return null;
    if (typeof ts === 'string') {
        const trimmed = ts.trim();
        return trimmed || null;
    }
    if (typeof ts === 'number' && Number.isFinite(ts) && ts > 0) {
        const ms = ts < 1e12 ? ts * 1000 : ts;
        const d = new Date(ms);
        if (!Number.isNaN(d.getTime())) {
            const hh = String(d.getHours()).padStart(2, '0');
            const mm = String(d.getMinutes()).padStart(2, '0');
            return `${hh}:${mm}`;
        }
    }
    return null;
}

/**
 * Manages per-sender forwarded message buffers, debounce timers, and manual /collect mode.
 */
class ForwardSessionManager {
    /**
     * @param {{ debounceMs?: number, autoAnalyze?: boolean, maxBufferItems?: number }} [options]
     */
    constructor({ debounceMs = 6000, autoAnalyze = true, maxBufferItems = 200 } = {}) {
        this.debounceMs = debounceMs;
        this.autoAnalyze = autoAnalyze;
        this.maxBufferItems = maxBufferItems;
        /** @type {Map<string, { items: Array<object>, collectMode: boolean, timer: NodeJS.Timeout|null }>} */
        this.sessions = new Map();
    }

    _getOrCreate(sender) {
        let state = this.sessions.get(sender);
        if (!state) {
            state = { items: [], collectMode: false, timer: null };
            this.sessions.set(sender, state);
        }
        return state;
    }

    _clearTimer(state) {
        if (state && state.timer) {
            clearTimeout(state.timer);
            state.timer = null;
        }
    }

    /**
     * Append a forwarded message item and schedule debounce callback if not in /collect mode.
     * @param {string} sender
     * @param {{ text?: string, timestamp?: string|number|null, mediaType?: string|null, quotedText?: string|null, imageDataUrl?: string|null }} item
     * @param {{ onAutoAnalyze?: (sender: string) => void, onManualAck?: (sender: string, count: number) => void }} [callbacks]
     * @returns {number} Current buffered item count
     */
    addItem(sender, item, callbacks = {}) {
        const state = this._getOrCreate(sender);
        const normalizedItem = {
            text: String(item.text || '').trim(),
            timestamp: item.timestamp ?? null,
            mediaType: item.mediaType ? String(item.mediaType).trim() : null,
            quotedText: item.quotedText ? String(item.quotedText).trim() : null,
            imageDataUrl: item.imageDataUrl || null
        };

        if (state.items.length >= this.maxBufferItems) {
            state.items.shift();
        }
        state.items.push(normalizedItem);

        this._clearTimer(state);

        if (!state.collectMode) {
            if (this.autoAnalyze && typeof callbacks.onAutoAnalyze === 'function') {
                state.timer = setTimeout(() => {
                    state.timer = null;
                    callbacks.onAutoAnalyze(sender);
                }, this.debounceMs);
            } else if (!this.autoAnalyze && typeof callbacks.onManualAck === 'function') {
                const ackDelay = Math.min(this.debounceMs, 2500);
                state.timer = setTimeout(() => {
                    state.timer = null;
                    callbacks.onManualAck(sender, state.items.length);
                }, ackDelay);
            }
        }

        return state.items.length;
    }

    /**
     * Drain buffered items for a sender and clear any pending debounce timer.
     * @param {string} sender
     * @param {{ exitCollectMode?: boolean }} [options]
     */
    consume(sender, { exitCollectMode = false } = {}) {
        const state = this.sessions.get(sender);
        if (!state) return [];

        this._clearTimer(state);
        const items = state.items.slice();
        state.items = [];
        if (exitCollectMode) {
            state.collectMode = false;
        }
        return items;
    }

    /**
     * Format buffered forwarded items into a clean numbered transcript for the LLM.
     * @param {Array<{ text?: string, timestamp?: string|number|null, mediaType?: string|null, quotedText?: string|null }>} items
     * @returns {string}
     */
    formatItems(items) {
        if (!Array.isArray(items) || items.length === 0) return '';

        const header = `[以下是用户直接转发的 WhatsApp 聊天记录，共 ${items.length} 条，按转发顺序排列]`;
        const lines = items.map((item, index) => {
            const parts = [`${index + 1}.`];
            const timeLabel = formatTimestamp(item.timestamp);
            if (timeLabel) {
                parts.push(`[${timeLabel}]`);
            }
            if (item.quotedText) {
                const compactQuote = item.quotedText.replace(/\s+/g, ' ').slice(0, 120);
                parts.push(`[回复 "${compactQuote}"]`);
            }
            if (item.mediaType) {
                parts.push(item.mediaType);
            }
            if (item.text) {
                parts.push(item.text);
            } else if (!item.mediaType) {
                parts.push('[空消息]');
            }
            return parts.join(' ');
        });

        return `${header}\n${lines.join('\n')}`;
    }

    /**
     * Toggle or set manual /collect mode for a sender.
     * @param {string} sender
     * @param {boolean} enabled
     */
    setCollectMode(sender, enabled) {
        const state = this._getOrCreate(sender);
        state.collectMode = Boolean(enabled);
        if (state.collectMode) {
            this._clearTimer(state);
        }
        return state.collectMode;
    }

    /**
     * Inspect current buffer status and previews for /buffer.
     * @param {string} sender
     */
    getStatus(sender) {
        const state = this.sessions.get(sender);
        if (!state) {
            return { count: 0, collectMode: false, previews: [] };
        }

        const previews = state.items.slice(-3).map((item) => {
            const raw = [item.mediaType, item.text].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
            if (!raw) return '[空消息]';
            return raw.length > 40 ? `${raw.slice(0, 40)}...` : raw;
        });

        return {
            count: state.items.length,
            collectMode: state.collectMode,
            previews
        };
    }

    /**
     * Clear pending items and timer for a sender without changing collectMode unless requested.
     * @param {string} sender
     * @param {{ exitCollectMode?: boolean }} [options]
     */
    clear(sender, { exitCollectMode = false } = {}) {
        const state = this.sessions.get(sender);
        if (!state) return 0;
        this._clearTimer(state);
        const clearedCount = state.items.length;
        state.items = [];
        if (exitCollectMode) {
            state.collectMode = false;
        }
        return clearedCount;
    }

    /**
     * Clear all active timers on graceful shutdown.
     */
    dispose() {
        for (const state of this.sessions.values()) {
            this._clearTimer(state);
        }
        this.sessions.clear();
    }
}

module.exports = {
    ForwardSessionManager,
    formatTimestamp
};
