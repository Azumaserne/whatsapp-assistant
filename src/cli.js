const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('node:readline/promises');
const { execFileSync, spawn } = require('child_process');

const { detectModelMultimodal, hasValidApiKey } = require('./config');
const { SUPPORTED_LANGS, LANG_META, resolveExplicitLang, normalizeLang, t } = require('./i18n');

const PROVIDER_PRESETS = [
    { id: '1', name: 'OpenAI', url: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
    { id: '2', name: 'DeepSeek', url: 'https://api.deepseek.com', model: 'deepseek-chat' },
    { id: '3', name: 'OpenRouter', url: 'https://openrouter.ai/api/v1', model: 'openai/gpt-4o-mini' },
    { id: '4', name: 'Google Gemini', url: 'https://generativelanguage.googleapis.com/v1beta/openai/', model: 'gemini-2.5-flash' },
    { id: '5', name: 'Moonshot / Kimi', url: 'https://api.moonshot.cn/v1', model: 'moonshot-v1-8k' },
    { id: '6', name: 'Zhipu GLM', url: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4-flash' },
    { id: '7', name: 'Local Ollama', url: 'http://localhost:11434/v1', model: 'qwen2.5:7b', isOllama: true }
];

const DEFAULT_ENV_MAP = {
    UI_LANG: 'zh',
    LLM_API_KEY: '',
    LLM_BASE_URL: 'https://api.openai.com/v1',
    LLM_MODEL: 'gpt-4o-mini',
    LLM_MULTIMODAL: 'auto',
    LLM_TEMPERATURE: '0.7',
    LLM_MAX_TOKENS: '1500',
    LLM_TIMEOUT_MS: '60000',
    FORWARD_AUTO_ANALYZE: 'true',
    FORWARD_DEBOUNCE_MS: '6000',
    MAX_CHAT_EXPORT_CHARS: '60000',
    MAX_HISTORY: '24',
    ALLOWED_NUMBERS: '',
    ENABLE_SELF_CHAT: 'false',
    SELF_CHAT_REPLY_PREFIX: '🤖 ',
    REPLY_DELAY_MIN_MS: '1200',
    REPLY_DELAY_MAX_MS: '3000',
    CHROME_PATH: ''
};

function resolveDesktopDir(env = process.env) {
    if (env.WA_DESKTOP_DIR && env.WA_DESKTOP_DIR.trim()) {
        return path.resolve(env.WA_DESKTOP_DIR.trim());
    }

    if (process.platform === 'win32') {
        try {
            const out = execFileSync(
                'reg.exe',
                ['query', 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\User Shell Folders', '/v', 'Desktop'],
                { encoding: 'utf8', windowsHide: true }
            );
            const match = out.match(/Desktop\s+REG_(?:EXPAND_)?SZ\s+(.+)/i);
            if (match && match[1]) {
                const expanded = match[1].trim().replace(/%([^%]+)%/g, (_, name) => env[name] || '');
                if (expanded) {
                    return path.resolve(expanded);
                }
            }
        } catch {
            // Fall back to standard USERPROFILE\Desktop
        }
        return path.join(env.USERPROFILE || os.homedir(), 'Desktop');
    }

    return path.join(os.homedir(), 'Desktop');
}

function detectWindowsBrowser(env = process.env) {
    if (process.platform !== 'win32') return '';
    const candidates = [
        env.ProgramFiles && path.join(env.ProgramFiles, 'Google', 'Chrome', 'Application', 'chrome.exe'),
        env['ProgramFiles(x86)'] && path.join(env['ProgramFiles(x86)'], 'Google', 'Chrome', 'Application', 'chrome.exe'),
        env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe'),
        env.ProgramFiles && path.join(env.ProgramFiles, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
        env['ProgramFiles(x86)'] && path.join(env['ProgramFiles(x86)'], 'Microsoft', 'Edge', 'Application', 'msedge.exe')
    ].filter(Boolean);

    for (const candidate of candidates) {
        if (fs.existsSync(candidate)) {
            return candidate;
        }
    }
    return '';
}

function parseEnvText(rawText) {
    const result = {};
    const lines = String(rawText || '').replace(/^\uFEFF/, '').split(/\r?\n/);
    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eqIdx = trimmed.indexOf('=');
        if (eqIdx < 1) continue;
        const key = trimmed.slice(0, eqIdx).trim();
        let val = trimmed.slice(eqIdx + 1).trim();
        if (
            val.length >= 2 &&
            ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'")))
        ) {
            val = val.slice(1, -1);
        }
        result[key] = val;
    }
    return result;
}

function serializeEnvMap(map) {
    const lines = [
        '# WhatsApp AI Assistant — Runtime Configuration',
        `# Updated: ${new Date().toISOString()}`
    ];
    for (const [k, v] of Object.entries(map)) {
        lines.push(`${k}=${v ?? ''}`);
    }
    return `${lines.join('\n')}\n`;
}

function maskApiKey(apiKey) {
    const trimmed = String(apiKey || '').trim();
    if (!trimmed) return '';
    if (trimmed.length <= 8) return '*'.repeat(trimmed.length);
    return `${trimmed.slice(0, 4)}****${trimmed.slice(-4)}`;
}

function loadSavedEnvMap(configEnvPath, legacyEnvPath) {
    const map = { ...DEFAULT_ENV_MAP };
    let sourceLabel = 'defaults';
    let hasSavedLang = false;

    const candidatePath = fs.existsSync(configEnvPath)
        ? configEnvPath
        : (legacyEnvPath && fs.existsSync(legacyEnvPath) ? legacyEnvPath : null);

    if (candidatePath) {
        sourceLabel = candidatePath;
        const parsed = parseEnvText(fs.readFileSync(candidatePath, 'utf-8'));
        if (parsed.UI_LANG && resolveExplicitLang(parsed.UI_LANG)) {
            hasSavedLang = true;
        }
        if (!parsed.LLM_API_KEY && parsed.DEEPSEEK_API_KEY) {
            map.LLM_API_KEY = parsed.DEEPSEEK_API_KEY;
            if (!parsed.LLM_BASE_URL) map.LLM_BASE_URL = 'https://api.deepseek.com';
            if (!parsed.LLM_MODEL) map.LLM_MODEL = 'deepseek-chat';
        }
        for (const [k, v] of Object.entries(parsed)) {
            if (k === 'DEEPSEEK_API_KEY') continue;
            map[k] = v;
        }
    }

    map.UI_LANG = normalizeLang(map.UI_LANG, 'zh');
    return { map, sourceLabel, hasSavedLang };
}

function formatMultimodalStatus(info, lang) {
    if (info && info.supported) return t(lang, 'cli.mm.supported');
    if (info && info.status === 'unknown') return t(lang, 'cli.mm.unknown');
    return t(lang, 'cli.mm.nonmm');
}

function buildSetupSummaryText(map, paths, multimodalInfo, lang) {
    const activeLang = normalizeLang(lang, 'zh');
    const maskedKey = maskApiKey(map.LLM_API_KEY) || t(activeLang, 'cli.val.unset');
    const fwdText = map.FORWARD_AUTO_ANALYZE === 'false'
        ? t(activeLang, 'cli.val.fwd_manual')
        : t(activeLang, 'cli.val.fwd_auto', { ms: map.FORWARD_DEBOUNCE_MS || '6000' });
    const whitelistText = (map.ALLOWED_NUMBERS || '').trim() || t(activeLang, 'cli.val.whitelist_all');
    const selfChatText = map.ENABLE_SELF_CHAT === 'true'
        ? t(activeLang, 'cli.val.enabled')
        : t(activeLang, 'cli.val.disabled');
    const chromeText = (map.CHROME_PATH || '').trim() || t(activeLang, 'cli.val.browser_default');

    return [
        '======================================================================',
        t(activeLang, 'cli.setup_header'),
        '======================================================================',
        `${t(activeLang, 'cli.setup_time').padEnd(14)}: ${new Date().toLocaleString()}`,
        `${t(activeLang, 'cli.summary_lang').padEnd(14)}: ${LANG_META[activeLang].nativeName} (${activeLang})`,
        `${t(activeLang, 'cli.summary_url').padEnd(14)}: ${map.LLM_BASE_URL}`,
        `${t(activeLang, 'cli.summary_model').padEnd(14)}: ${map.LLM_MODEL}`,
        `${t(activeLang, 'cli.summary_mm').padEnd(14)}: ${formatMultimodalStatus(multimodalInfo, activeLang)}`,
        `${t(activeLang, 'cli.summary_key').padEnd(14)}: ${maskedKey}`,
        `${t(activeLang, 'cli.summary_fwd').padEnd(14)}: ${fwdText}`,
        `${t(activeLang, 'cli.summary_whitelist').padEnd(14)}: ${whitelistText}`,
        `${t(activeLang, 'cli.summary_selfchat').padEnd(14)}: ${selfChatText}`,
        `${t(activeLang, 'cli.summary_chrome').padEnd(14)}: ${chromeText}`,
        '----------------------------------------------------------------------',
        t(activeLang, 'cli.setup_files'),
        t(activeLang, 'cli.setup_f1', { path: paths.configEnvPath }),
        t(activeLang, 'cli.setup_f2', { path: paths.setupInfoPath }),
        t(activeLang, 'cli.setup_f3', { path: paths.memoryPath }),
        t(activeLang, 'cli.setup_f4', { path: paths.recordsGlob }),
        '----------------------------------------------------------------------',
        t(activeLang, 'cli.setup_disclaimer'),
        'MIT License | by @Azumaserne'
    ].join('\r\n') + '\r\n';
}

function parseCliArgs(argv = []) {
    const flags = {
        checkOnly: false,
        verifyRuntime: false,
        reconfigure: false,
        lang: null
    };

    for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i];
        if (arg === '--check-only') flags.checkOnly = true;
        else if (arg === '--verify-runtime') flags.verifyRuntime = true;
        else if (arg === '--reconfigure') flags.reconfigure = true;
        else if (arg.startsWith('--lang=')) flags.lang = resolveExplicitLang(arg.slice('--lang='.length));
        else if (arg === '--lang' && argv[i + 1]) {
            flags.lang = resolveExplicitLang(argv[i + 1]);
            i += 1;
        }
    }

    return flags;
}

function openFolderInOs(dirPath) {
    try {
        if (process.platform === 'win32') {
            spawn('explorer.exe', [dirPath], { detached: true, stdio: 'ignore' }).unref();
        } else if (process.platform === 'darwin') {
            spawn('open', [dirPath], { detached: true, stdio: 'ignore' }).unref();
        } else {
            spawn('xdg-open', [dirPath], { detached: true, stdio: 'ignore' }).unref();
        }
    } catch {
        // Ignore OS file explorer launch errors
    }
}

async function promptWithDefault(rl, label, defaultValue = '') {
    const promptText = defaultValue ? `${label} [${defaultValue}]: ` : `${label}: `;
    const answer = (await rl.question(promptText)).trim();
    return answer || defaultValue;
}

async function selectLanguagePrompt(rl, currentLang = 'zh') {
    console.log('\nSelect Language / 选择语言 / Sprache wählen:');
    console.log('  [1] 简体中文 (zh)');
    console.log('  [2] English (en)');
    console.log('  [3] Deutsch (de)');
    const defaultNum = currentLang === 'en' ? '2' : (currentLang === 'de' ? '3' : '1');
    const answer = (await rl.question(`Choice / 选择 / Auswahl [${defaultNum}]: `)).trim();
    return resolveExplicitLang(answer || defaultNum) || currentLang;
}

function printBanner(lang, dataDir) {
    console.log('\n======================================================================');
    console.log(`  ${t(lang, 'cli.title')}`);
    console.log(`  ${t(lang, 'cli.subtitle')}`);
    console.log('======================================================================');
    console.log(t(lang, 'cli.disclaimer_1'));
    console.log(t(lang, 'cli.disclaimer_2'));
    console.log(t(lang, 'cli.disclaimer_3'));
    console.log(t(lang, 'cli.desktop_dir_note'));
    console.log(`      ${dataDir}`);
    console.log('----------------------------------------------------------------------\n');
}

function printMultimodalNotice(modelName, mmInfo, lang) {
    if (mmInfo && mmInfo.supported) {
        console.log(t(lang, 'cli.notice.mm_ok', { model: modelName }));
    } else if (mmInfo && mmInfo.status === 'unknown') {
        console.warn(t(lang, 'cli.notice.mm_unknown', { model: modelName }));
    } else {
        console.warn(t(lang, 'cli.notice.mm_nonmm', { model: modelName }));
    }
}

function printSummary(map, dataDir, lang) {
    const mmInfo = detectModelMultimodal(map.LLM_MODEL, map.LLM_MULTIMODAL);
    const fwdText = map.FORWARD_AUTO_ANALYZE === 'false'
        ? t(lang, 'cli.val.fwd_manual')
        : t(lang, 'cli.val.fwd_auto', { ms: map.FORWARD_DEBOUNCE_MS || '6000' });
    const whitelistText = (map.ALLOWED_NUMBERS || '').trim() || t(lang, 'cli.val.whitelist_all');
    const selfChatText = map.ENABLE_SELF_CHAT === 'true' ? t(lang, 'cli.val.enabled') : t(lang, 'cli.val.disabled');
    const chromeText = (map.CHROME_PATH || '').trim() || t(lang, 'cli.val.browser_default');
    const maskedKey = maskApiKey(map.LLM_API_KEY) || t(lang, 'cli.val.unset');

    console.log(t(lang, 'cli.summary_title'));
    console.log(`   • ${t(lang, 'cli.summary_lang').padEnd(14)} : ${LANG_META[lang].nativeName} (${lang})`);
    console.log(`   • ${t(lang, 'cli.summary_url').padEnd(14)} : ${map.LLM_BASE_URL}`);
    console.log(`   • ${t(lang, 'cli.summary_model').padEnd(14)} : ${map.LLM_MODEL}`);
    console.log(`   • ${t(lang, 'cli.summary_mm').padEnd(14)} : ${formatMultimodalStatus(mmInfo, lang)}`);
    console.log(`   • ${t(lang, 'cli.summary_key').padEnd(14)} : ${maskedKey}`);
    console.log(`   • ${t(lang, 'cli.summary_fwd').padEnd(14)} : ${fwdText}`);
    console.log(`   • ${t(lang, 'cli.summary_whitelist').padEnd(14)} : ${whitelistText}`);
    console.log(`   • ${t(lang, 'cli.summary_selfchat').padEnd(14)} : ${selfChatText}`);
    console.log(`   • ${t(lang, 'cli.summary_chrome').padEnd(14)} : ${chromeText}`);
    console.log(`   • ${t(lang, 'cli.summary_desktop').padEnd(14)} : ${dataDir}\n`);
    printMultimodalNotice(map.LLM_MODEL, mmInfo, lang);
    console.log('');
}

async function runWizard(rl, currentMap, lang, isPackagedExe) {
    const next = { ...currentMap, UI_LANG: lang };
    console.log(t(lang, 'cli.wizard.header'));
    console.log('');
    console.log(t(lang, 'cli.wizard.presets'));
    for (const preset of PROVIDER_PRESETS) {
        console.log(`  [${preset.id}] ${preset.name.padEnd(16)} (${preset.url} | ${preset.model})`);
    }
    console.log(t(lang, 'cli.wizard.preset_8'));
    console.log('');

    const matchedPreset = PROVIDER_PRESETS.find((p) => p.url === next.LLM_BASE_URL);
    const defaultPresetId = matchedPreset ? matchedPreset.id : '8';
    const presetChoice = await promptWithDefault(rl, t(lang, 'cli.wizard.preset_prompt'), defaultPresetId);
    const chosenPreset = PROVIDER_PRESETS.find((p) => p.id === presetChoice);

    let suggestedModel = next.LLM_MODEL;
    if (chosenPreset) {
        next.LLM_BASE_URL = chosenPreset.url;
        if (currentMap.LLM_BASE_URL !== chosenPreset.url || !next.LLM_MODEL) {
            suggestedModel = chosenPreset.model;
        }
    } else {
        next.LLM_BASE_URL = await promptWithDefault(rl, t(lang, 'cli.wizard.base_url'), next.LLM_BASE_URL);
    }

    next.LLM_MODEL = await promptWithDefault(rl, t(lang, 'cli.wizard.model'), suggestedModel);
    const autoMmInfo = detectModelMultimodal(next.LLM_MODEL, 'auto');
    printMultimodalNotice(next.LLM_MODEL, autoMmInfo, lang);

    const mmChoice = (await promptWithDefault(rl, t(lang, 'cli.wizard.mm_override'), next.LLM_MULTIMODAL || 'auto')).toLowerCase();
    next.LLM_MULTIMODAL = ['auto', 'true', 'false'].includes(mmChoice) ? mmChoice : 'auto';

    const existingValid = hasValidApiKey({ apiKey: next.LLM_API_KEY });
    if (chosenPreset?.isOllama) {
        const defaultOllama = existingValid ? next.LLM_API_KEY : 'ollama';
        next.LLM_API_KEY = await promptWithDefault(rl, t(lang, 'cli.wizard.key_ollama'), defaultOllama);
    } else {
        while (true) {
            const promptStr = existingValid
                ? t(lang, 'cli.wizard.key_keep', { masked: maskApiKey(next.LLM_API_KEY) })
                : t(lang, 'cli.wizard.key_required');
            const entered = (await rl.question(promptStr)).trim();
            if (!entered && existingValid) {
                break;
            }
            if (hasValidApiKey({ apiKey: entered })) {
                next.LLM_API_KEY = entered;
                break;
            }
            console.warn(t(lang, 'cli.wizard.key_invalid'));
        }
    }

    console.log('');
    console.log(t(lang, 'cli.wizard.fwd_title'));
    console.log(t(lang, 'cli.wizard.fwd_1'));
    console.log(t(lang, 'cli.wizard.fwd_2'));
    const defaultFwd = next.FORWARD_AUTO_ANALYZE === 'false' ? '2' : '1';
    const fwdChoice = await promptWithDefault(rl, t(lang, 'cli.wizard.fwd_prompt'), defaultFwd);
    next.FORWARD_AUTO_ANALYZE = fwdChoice === '2' ? 'false' : 'true';
    next.FORWARD_DEBOUNCE_MS = await promptWithDefault(rl, t(lang, 'cli.wizard.debounce'), next.FORWARD_DEBOUNCE_MS || '6000');

    const whitelistCurrent = (next.ALLOWED_NUMBERS || '').trim() || t(lang, 'cli.val.whitelist_all');
    const whitelistInput = (await rl.question(t(lang, 'cli.wizard.whitelist', { current: whitelistCurrent }))).trim();
    if (whitelistInput) {
        next.ALLOWED_NUMBERS = ['none', '-'].includes(whitelistInput.toLowerCase()) ? '' : whitelistInput;
    }

    const defaultSelf = next.ENABLE_SELF_CHAT === 'true' ? 'y' : 'N';
    const selfAns = (await promptWithDefault(rl, t(lang, 'cli.wizard.selfchat'), defaultSelf)).toLowerCase();
    next.ENABLE_SELF_CHAT = (selfAns === 'y' || selfAns === 'true' || selfAns === 'yes') ? 'true' : 'false';

    const detectedBrowser = detectWindowsBrowser();
    const effectiveDefaultBrowser = (next.CHROME_PATH || '').trim() || detectedBrowser;
    console.log('');
    if (effectiveDefaultBrowser) {
        console.log(t(lang, 'cli.wizard.browser_found', { path: effectiveDefaultBrowser }));
        const browserAns = (await rl.question(t(lang, 'cli.wizard.browser_prompt_found'))).trim();
        if (!browserAns) {
            next.CHROME_PATH = effectiveDefaultBrowser;
        } else if (browserAns.toLowerCase() === 'auto') {
            next.CHROME_PATH = '';
        } else {
            next.CHROME_PATH = browserAns.replace(/^"+|"+$/g, '');
        }
    } else {
        const promptMsg = isPackagedExe
            ? t(lang, 'cli.wizard.browser_prompt_none_exe')
            : t(lang, 'cli.wizard.browser_prompt_none');
        const browserAns = (await rl.question(promptMsg)).trim();
        next.CHROME_PATH = browserAns.replace(/^"+|"+$/g, '');
    }

    return next;
}

function saveDesktopFiles(map, paths, lang) {
    fs.mkdirSync(paths.dataDir, { recursive: true });
    fs.mkdirSync(paths.recordsDir, { recursive: true });

    const finalMap = { ...map, UI_LANG: lang };
    fs.writeFileSync(paths.configEnvPath, serializeEnvMap(finalMap), 'utf-8');

    const mmInfo = detectModelMultimodal(finalMap.LLM_MODEL, finalMap.LLM_MULTIMODAL);
    const summaryText = buildSetupSummaryText(finalMap, paths, mmInfo, lang);
    // Write UTF-8 with BOM so Windows Notepad renders Chinese/German cleanly
    fs.writeFileSync(paths.setupInfoPath, `\uFEFF${summaryText}`, 'utf-8');

    console.log('');
    console.log(t(lang, 'cli.saved', { dir: paths.dataDir }));
    console.log(t(lang, 'cli.saved_env', { path: paths.configEnvPath }));
    console.log(t(lang, 'cli.saved_info', { path: paths.setupInfoPath }));
    console.log(t(lang, 'cli.saved_records', { path: paths.recordsGlob }));
    console.log('');
}

async function waitForEnter(lang) {
    if (!process.stdin.isTTY) return;
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    try {
        await rl.question(t(lang, 'cli.press_enter'));
    } finally {
        rl.close();
    }
}

function verifyRuntimeModules() {
    const whatsapp = require('whatsapp-web.js');
    const OpenAI = require('openai');
    const qrcode = require('qrcode-terminal');
    const dotenv = require('dotenv');
    const configMod = require('./config');

    const checks = {
        whatsappClient: typeof whatsapp.Client === 'function',
        localAuth: typeof whatsapp.LocalAuth === 'function',
        openai: typeof OpenAI === 'function',
        qrcode: typeof qrcode.generate === 'function',
        dotenv: typeof dotenv.config === 'function',
        multimodalDetect: configMod.detectModelMultimodal('deepseek-chat').status === 'non-multimodal',
        langs: SUPPORTED_LANGS.every((code) => Boolean(t(code, 'cli.title')))
    };

    const allOk = Object.values(checks).every(Boolean);
    if (!allOk) {
        throw new Error(`Runtime verification failed: ${JSON.stringify(checks)}`);
    }
    return { status: 'RUNTIME_OK', node: process.version, packagedExe: process.env.WA_PACKAGED_EXE === '1', checks };
}

/**
 * Interactive multilingual launcher shared by source CLI, PowerShell wrapper, and standalone .exe.
 * @param {{ projectDir?: string, argv?: string[], isPackagedExe?: boolean }} [options]
 */
async function runCli({
    projectDir = path.resolve(__dirname, '..'),
    argv = process.argv.slice(2),
    isPackagedExe = process.env.WA_PACKAGED_EXE === '1'
} = {}) {
    const flags = parseCliArgs(argv);

    if (flags.verifyRuntime) {
        const result = verifyRuntimeModules();
        console.log(JSON.stringify(result));
        return;
    }

    const desktopDir = resolveDesktopDir(process.env);
    const dataDir = path.join(desktopDir, 'WhatsApp-Assistant-Data');
    const paths = {
        dataDir,
        configEnvPath: path.join(dataDir, 'config.env'),
        setupInfoPath: path.join(dataDir, 'setup-info.txt'),
        memoryPath: path.join(dataDir, 'memory.json'),
        recordsDir: path.join(dataDir, 'records'),
        recordsGlob: path.join(dataDir, 'records', 'YYYY-MM-DD.md')
    };
    const legacyEnvPath = isPackagedExe ? null : path.join(projectDir, '.env');

    const loaded = loadSavedEnvMap(paths.configEnvPath, legacyEnvPath);
    let configMap = loaded.map;
    let activeLang = flags.lang || configMap.UI_LANG || 'zh';

    if (flags.checkOnly) {
        const detectedBrowser = detectWindowsBrowser();
        const mmInfo = detectModelMultimodal(configMap.LLM_MODEL, configMap.LLM_MULTIMODAL);
        printBanner(activeLang, dataDir);
        console.log(`CheckOnly (${activeLang}):`);
        console.log(`  • Node.js       : ${process.version}`);
        console.log(`  • Packaged EXE  : ${Boolean(isPackagedExe)}`);
        console.log(`  • Config Source : ${loaded.sourceLabel}`);
        console.log(`  • Model         : ${configMap.LLM_MODEL} (${formatMultimodalStatus(mmInfo, activeLang)})`);
        console.log(`  • Browser       : ${detectedBrowser || t(activeLang, 'cli.val.browser_default')}`);
        console.log(`  • Desktop Dir   : ${dataDir}`);
        console.log(`  • Config Target : ${paths.configEnvPath}`);
        console.log(`  • Records Dir   : ${paths.recordsDir}`);
        return;
    }

    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    let shouldLaunch = false;

    try {
        if (!flags.lang && !loaded.hasSavedLang) {
            activeLang = await selectLanguagePrompt(rl, activeLang);
        }
        configMap.UI_LANG = activeLang;

        printBanner(activeLang, dataDir);

        const hasValidKey = hasValidApiKey({ apiKey: configMap.LLM_API_KEY });
        if (flags.reconfigure || !hasValidKey) {
            if (!hasValidKey) {
                console.log(t(activeLang, 'cli.first_run'));
                console.log('');
            }
            configMap = await runWizard(rl, configMap, activeLang, isPackagedExe);
            saveDesktopFiles(configMap, paths, activeLang);
            shouldLaunch = true;
        } else {
            // Auto-fill detected browser if standalone exe and CHROME_PATH is empty
            if (isPackagedExe && !String(configMap.CHROME_PATH || '').trim()) {
                const autoBrowser = detectWindowsBrowser();
                if (autoBrowser) {
                    configMap.CHROME_PATH = autoBrowser;
                }
            }

            while (true) {
                printSummary(configMap, dataDir, activeLang);
                console.log(t(activeLang, 'cli.menu.title'));
                console.log(t(activeLang, 'cli.menu.1'));
                console.log(t(activeLang, 'cli.menu.2'));
                console.log(t(activeLang, 'cli.menu.3'));
                console.log(t(activeLang, 'cli.menu.4'));
                console.log(t(activeLang, 'cli.menu.5'));
                const choice = ((await rl.question(t(activeLang, 'cli.menu.prompt'))).trim() || '1');

                if (choice === '1') {
                    saveDesktopFiles(configMap, paths, activeLang);
                    shouldLaunch = true;
                    break;
                }
                if (choice === '2') {
                    configMap = await runWizard(rl, configMap, activeLang, isPackagedExe);
                    saveDesktopFiles(configMap, paths, activeLang);
                    shouldLaunch = true;
                    break;
                }
                if (choice === '3') {
                    saveDesktopFiles(configMap, paths, activeLang);
                    openFolderInOs(dataDir);
                    continue;
                }
                if (choice === '4') {
                    activeLang = await selectLanguagePrompt(rl, activeLang);
                    configMap.UI_LANG = activeLang;
                    saveDesktopFiles(configMap, paths, activeLang);
                    printBanner(activeLang, dataDir);
                    continue;
                }
                if (choice === '5') {
                    shouldLaunch = false;
                    break;
                }
                console.warn(t(activeLang, 'cli.menu.invalid'));
            }
        }
    } finally {
        rl.close();
    }

    if (!shouldLaunch) return;

    process.env.ENV_FILE = paths.configEnvPath;
    process.env.DATA_DIR = paths.dataDir;
    process.env.UI_LANG = activeLang;

    console.log(t(activeLang, 'cli.launching'));
    console.log(t(activeLang, 'cli.launching_hint'));
    console.log('');

    try {
        const { startAssistant } = require(path.join(projectDir, 'index.js'));
        await startAssistant({ baseDir: projectDir, exitOnShutdown: true });
    } catch (error) {
        console.error('❌', error);
        await waitForEnter(activeLang);
        process.exitCode = 1;
    }
}

if (require.main === module) {
    runCli().catch(async (error) => {
        console.error('❌ Fatal CLI error:', error);
        await waitForEnter('zh');
        process.exit(1);
    });
}

module.exports = {
    runCli,
    resolveDesktopDir,
    detectWindowsBrowser,
    parseEnvText,
    serializeEnvMap,
    maskApiKey,
    buildSetupSummaryText,
    parseCliArgs
};
