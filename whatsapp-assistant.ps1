[CmdletBinding()]
param(
    [switch]$Reconfigure,
    [switch]$CheckOnly
)

$ErrorActionPreference = 'Stop'

# Ensure UTF-8 console encoding for Chinese text and QR code box-drawing characters
try {
    $utf8NoBom = [System.Text.UTF8Encoding]::new($false)
    $utf8WithBom = [System.Text.UTF8Encoding]::new($true)
    $OutputEncoding = $utf8NoBom
    [Console]::InputEncoding = $utf8NoBom
    [Console]::OutputEncoding = $utf8NoBom
    chcp 65001 | Out-Null
    $Host.UI.RawUI.WindowTitle = 'WhatsApp AI Assistant (@Azumaserne)'
} catch {
    $utf8NoBom = [System.Text.UTF8Encoding]::new($false)
    $utf8WithBom = [System.Text.UTF8Encoding]::new($true)
}

$ProjectDir = $PSScriptRoot
$DesktopDir = [Environment]::GetFolderPath('Desktop')
if ([string]::IsNullOrWhiteSpace($DesktopDir)) {
    $DesktopDir = Join-Path $env:USERPROFILE 'Desktop'
}
$DataDir = Join-Path $DesktopDir 'WhatsApp-Assistant-Data'
$ConfigEnvPath = Join-Path $DataDir 'config.env'
$SetupInfoPath = Join-Path $DataDir 'setup-info.txt'
$RecordsDir = Join-Path $DataDir 'records'
$LegacyEnvPath = Join-Path $ProjectDir '.env'

function Write-HeaderBanner {
    Write-Host ''
    Write-Host '======================================================================' -ForegroundColor Cyan
    Write-Host '  WhatsApp AI Assistant  —  一键启动配置与扫码控制台' -ForegroundColor Cyan
    Write-Host '  直接转发聊天记录 / 导出文件即可 AI 分析（无需截图） | by @Azumaserne' -ForegroundColor DarkCyan
    Write-Host '======================================================================' -ForegroundColor Cyan
    Write-Host '⚠️  重要声明：' -ForegroundColor Yellow
    Write-Host '   1. 本助手需自备 OpenAI 兼容 API Key（BYO API）。' -ForegroundColor Yellow
    Write-Host '   2. 基于非官方 whatsapp-web.js，存在封号/风控风险，封号不负责，' -ForegroundColor Yellow
    Write-Host '      强烈建议使用独立 WhatsApp 小号挂载！' -ForegroundColor Yellow
    Write-Host '   3. 所有配置、对话记忆与每日 Markdown 分析记录将自动保存到桌面目录：' -ForegroundColor Gray
    Write-Host "      $DataDir" -ForegroundColor Green
    Write-Host '----------------------------------------------------------------------' -ForegroundColor DarkGray
    Write-Host ''
}

function Find-BrowserExecutable {
    $candidates = @(
        (Join-Path $env:ProgramFiles 'Google\Chrome\Application\chrome.exe'),
        (Join-Path ${env:ProgramFiles(x86)} 'Google\Chrome\Application\chrome.exe'),
        (Join-Path $env:LOCALAPPDATA 'Google\Chrome\Application\chrome.exe'),
        (Join-Path $env:ProgramFiles 'Microsoft\Edge\Application\msedge.exe'),
        (Join-Path ${env:ProgramFiles(x86)} 'Microsoft\Edge\Application\msedge.exe')
    )
    foreach ($candidate in $candidates) {
        if (-not [string]::IsNullOrWhiteSpace($candidate) -and (Test-Path -LiteralPath $candidate)) {
            return $candidate
        }
    }
    return ''
}

function Read-EnvMap {
    param([string]$FilePath)
    $map = [ordered]@{}
    if (-not (Test-Path -LiteralPath $FilePath)) {
        return $map
    }
    $lines = [System.IO.File]::ReadAllLines($FilePath, $utf8NoBom)
    foreach ($line in $lines) {
        $trimmed = $line.Trim()
        if ($trimmed -eq '' -or $trimmed.StartsWith('#')) {
            continue
        }
        $eqIdx = $trimmed.IndexOf('=')
        if ($eqIdx -lt 1) {
            continue
        }
        $key = $trimmed.Substring(0, $eqIdx).Trim()
        $val = $trimmed.Substring($eqIdx + 1).Trim()
        if (($val.StartsWith('"') -and $val.EndsWith('"')) -or ($val.StartsWith("'") -and $val.EndsWith("'"))) {
            if ($val.Length -ge 2) {
                $val = $val.Substring(1, $val.Length - 2)
            }
        }
        $map[$key] = $val
    }
    return $map
}

function Get-MaskedKey {
    param([string]$ApiKey)
    if ([string]::IsNullOrWhiteSpace($ApiKey)) {
        return '(未设置)'
    }
    $k = $ApiKey.Trim()
    if ($k.Length -le 8) {
        return ('*' * $k.Length)
    }
    return ($k.Substring(0, 4) + '****' + $k.Substring($k.Length - 4))
}

function Test-ValidApiKeyLocal {
    param([string]$ApiKey)
    if ([string]::IsNullOrWhiteSpace($ApiKey)) {
        return $false
    }
    $lower = $ApiKey.Trim().ToLowerInvariant()
    foreach ($pattern in @('your-api-key', '请替换', 'sk-xxx', 'replace-me')) {
        if ($lower.Contains($pattern)) {
            return $false
        }
    }
    return $true
}

function Get-MultimodalInfo {
    param(
        [string]$ModelName,
        [string]$OverrideVal
    )
    $nodeCmd = Get-Command node -ErrorAction SilentlyContinue
    if ($null -eq $nodeCmd) {
        return [PSCustomObject]@{ supported = $false; status = 'unknown'; source = 'auto' }
    }
    $prevModel = $env:__WA_CHECK_MODEL
    $prevOverride = $env:__WA_CHECK_MM
    try {
        $env:__WA_CHECK_MODEL = $ModelName
        $env:__WA_CHECK_MM = $OverrideVal
        $scriptPath = Join-Path $ProjectDir 'src\config.js'
        $env:__WA_CFG_PATH = $scriptPath
        $json = & node -e "const { detectModelMultimodal } = require(process.env.__WA_CFG_PATH); console.log(JSON.stringify(detectModelMultimodal(process.env.__WA_CHECK_MODEL, process.env.__WA_CHECK_MM)));" 2>$null
        if ($LASTEXITCODE -eq 0 -and -not [string]::IsNullOrWhiteSpace($json)) {
            return ($json | ConvertFrom-Json)
        }
    } catch {
        # Fallback below
    } finally {
        $env:__WA_CHECK_MODEL = $prevModel
        $env:__WA_CHECK_MM = $prevOverride
        Remove-Item Env:\__WA_CFG_PATH -ErrorAction SilentlyContinue
    }
    return [PSCustomObject]@{ supported = $false; status = 'unknown'; source = 'auto' }
}

function Format-MultimodalStatusLabel {
    param($Info)
    if ($null -ne $Info -and $Info.supported) {
        return '支持多模态（可文字+识图）'
    }
    if ($null -ne $Info -and $Info.status -eq 'unknown') {
        return '未知（默认纯文本，可设 LLM_MULTIMODAL=true）'
    }
    return '非多模态（纯文本，无法识图，将向用户发出警告）'
}

function Show-MultimodalNotice {
    param(
        [string]$ModelName,
        $Info
    )
    if ($null -ne $Info -and $Info.supported) {
        Write-Host "  [多模态检测] 模型 '$ModelName' 支持多模态识图。" -ForegroundColor Green
    } elseif ($null -ne $Info -and $Info.status -eq 'unknown') {
        Write-Host "  ⚠️  [模型提醒] 未能确认模型 '$ModelName' 是否支持多模态，当前默认按纯文本运行（会在 WhatsApp 消息中提醒用户；如确定支持识图可将 LLM_MULTIMODAL 设为 true）。" -ForegroundColor Yellow
    } else {
        Write-Host "  ⚠️  [非多模态警告] 模型 '$ModelName' 为纯文本模型，无法识别图片/表情包/语音！运行时会在 WhatsApp 消息中主动向用户发出警告。" -ForegroundColor Yellow
    }
}

function Ensure-NodeInstalled {
    $nodeCmd = Get-Command node -ErrorAction SilentlyContinue
    if ($null -ne $nodeCmd) {
        return $true
    }

    Write-Host '❌ 未检测到 Node.js！运行本助手需要 Node.js 18 LTS 或更高版本。' -ForegroundColor Red
    $wingetCmd = Get-Command winget -ErrorAction SilentlyContinue
    if ($null -ne $wingetCmd) {
        $installChoice = Read-Host '检测到本机有 winget，是否立即尝试自动安装 Node.js LTS？(Y/n)'
        if ([string]::IsNullOrWhiteSpace($installChoice) -or $installChoice.Trim().ToLowerInvariant() -eq 'y') {
            & winget install -e --id OpenJS.NodeJS.LTS --accept-package-agreements --accept-source-agreements
            $env:Path = [System.Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [System.Environment]::GetEnvironmentVariable('Path', 'User')
            $nodeCmd = Get-Command node -ErrorAction SilentlyContinue
            if ($null -ne $nodeCmd) {
                Write-Host '✅ Node.js 安装成功！' -ForegroundColor Green
                return $true
            }
        }
    }

    Write-Host '请手动下载并安装 Node.js 18+ LTS：https://nodejs.org/' -ForegroundColor Yellow
    return $false
}

function Ensure-DependenciesInstalled {
    $nodeModulesDir = Join-Path $ProjectDir 'node_modules'
    if (Test-Path -LiteralPath $nodeModulesDir) {
        return $true
    }

    Write-Host '📦 首次运行未检测到 node_modules，正在当前项目目录自动执行 npm install ...' -ForegroundColor Cyan
    Push-Location $ProjectDir
    try {
        & npm install
        if ($LASTEXITCODE -ne 0) {
            Write-Host '❌ npm install 执行失败，请检查网络连接或 npm 配置后重试。' -ForegroundColor Red
            return $false
        }
        Write-Host '✅ 依赖安装完成！' -ForegroundColor Green
        return $true
    } finally {
        Pop-Location
    }
}

function Resolve-InitialConfigMap {
    $cfg = [ordered]@{
        LLM_API_KEY            = ''
        LLM_BASE_URL           = 'https://api.openai.com/v1'
        LLM_MODEL              = 'gpt-4o-mini'
        LLM_MULTIMODAL         = 'auto'
        LLM_TEMPERATURE        = '0.7'
        LLM_MAX_TOKENS         = '1500'
        LLM_TIMEOUT_MS         = '60000'
        FORWARD_AUTO_ANALYZE   = 'true'
        FORWARD_DEBOUNCE_MS    = '6000'
        MAX_CHAT_EXPORT_CHARS  = '60000'
        MAX_HISTORY            = '24'
        ALLOWED_NUMBERS        = ''
        ENABLE_SELF_CHAT       = 'false'
        SELF_CHAT_REPLY_PREFIX = '🤖 '
        REPLY_DELAY_MIN_MS     = '1200'
        REPLY_DELAY_MAX_MS     = '3000'
        CHROME_PATH            = ''
    }

    $sourceMap = $null
    $sourceLabel = '默认模板'

    if (Test-Path -LiteralPath $ConfigEnvPath) {
        $sourceMap = Read-EnvMap -FilePath $ConfigEnvPath
        $sourceLabel = $ConfigEnvPath
    } elseif (Test-Path -LiteralPath $LegacyEnvPath) {
        $sourceMap = Read-EnvMap -FilePath $LegacyEnvPath
        $sourceLabel = $LegacyEnvPath
    }

    if ($null -ne $sourceMap) {
        # Legacy DEEPSEEK_API_KEY compatibility when LLM_API_KEY is absent
        if (-not $sourceMap.Contains('LLM_API_KEY') -and $sourceMap.Contains('DEEPSEEK_API_KEY')) {
            $cfg['LLM_API_KEY'] = $sourceMap['DEEPSEEK_API_KEY']
            if (-not $sourceMap.Contains('LLM_BASE_URL')) {
                $cfg['LLM_BASE_URL'] = 'https://api.deepseek.com'
            }
            if (-not $sourceMap.Contains('LLM_MODEL')) {
                $cfg['LLM_MODEL'] = 'deepseek-chat'
            }
        }
        foreach ($k in $sourceMap.Keys) {
            if ($k -eq 'DEEPSEEK_API_KEY') {
                continue
            }
            $cfg[$k] = $sourceMap[$k]
        }
    }

    return [PSCustomObject]@{
        Map         = $cfg
        SourceLabel = $sourceLabel
    }
}

function Prompt-WithDefault {
    param(
        [string]$Label,
        [string]$DefaultValue = ''
    )
    if ([string]::IsNullOrEmpty($DefaultValue)) {
        return (Read-Host $Label).Trim()
    }
    $inputVal = Read-Host "$Label [默认: $DefaultValue]"
    if ([string]::IsNullOrWhiteSpace($inputVal)) {
        return $DefaultValue
    }
    return $inputVal.Trim()
}

function Show-ConfigSummary {
    param(
        [System.Collections.Specialized.OrderedDictionary]$ConfigMap,
        $MultimodalInfo
    )
    $mmLabel = Format-MultimodalStatusLabel -Info $MultimodalInfo
    $forwardLabel = if ($ConfigMap['FORWARD_AUTO_ANALYZE'] -eq 'false') {
        '手动触发 (/analyze)'
    } else {
        "自动防抖分析 ($($ConfigMap['FORWARD_DEBOUNCE_MS'])ms)"
    }
    $whitelistLabel = if ([string]::IsNullOrWhiteSpace($ConfigMap['ALLOWED_NUMBERS'])) {
        '未限制（响应所有私聊）'
    } else {
        $ConfigMap['ALLOWED_NUMBERS']
    }
    $selfChatLabel = if ($ConfigMap['ENABLE_SELF_CHAT'] -eq 'true') { '已开启' } else { '未开启' }
    $chromeLabel = if ([string]::IsNullOrWhiteSpace($ConfigMap['CHROME_PATH'])) { 'Puppeteer 自带/默认' } else { $ConfigMap['CHROME_PATH'] }

    Write-Host '📋 当前配置总览：' -ForegroundColor White
    Write-Host ("   • API 接口     : {0}" -f $ConfigMap['LLM_BASE_URL'])
    Write-Host ("   • 默认模型     : {0}" -f $ConfigMap['LLM_MODEL'])
    Write-Host ("   • 多模态状态   : {0}" -f $mmLabel)
    Write-Host ("   • API Key      : {0}" -f (Get-MaskedKey -ApiKey $ConfigMap['LLM_API_KEY']))
    Write-Host ("   • 转发分析模式 : {0}" -f $forwardLabel)
    Write-Host ("   • 联系人白名单 : {0}" -f $whitelistLabel)
    Write-Host ("   • 自聊模式     : {0}" -f $selfChatLabel)
    Write-Host ("   • 浏览器路径   : {0}" -f $chromeLabel)
    Write-Host ("   • 桌面保存目录 : {0}" -f $DataDir)
    Write-Host ''
    Show-MultimodalNotice -ModelName $ConfigMap['LLM_MODEL'] -Info $MultimodalInfo
    Write-Host ''
}

function Invoke-InteractiveWizard {
    param([System.Collections.Specialized.OrderedDictionary]$CurrentMap)

    Write-Host '🛠️  请按提示填写配置（直接回车可使用方括号内的默认值）：' -ForegroundColor Cyan
    Write-Host ''
    Write-Host '请选择 API 服务商预设：' -ForegroundColor White
    Write-Host '  [1] OpenAI             (https://api.openai.com/v1 | gpt-4o-mini)'
    Write-Host '  [2] DeepSeek           (https://api.deepseek.com | deepseek-chat)'
    Write-Host '  [3] OpenRouter         (https://openrouter.ai/api/v1 | openai/gpt-4o-mini)'
    Write-Host '  [4] Google Gemini      (https://generativelanguage.googleapis.com/v1beta/openai/ | gemini-2.5-flash)'
    Write-Host '  [5] Moonshot / Kimi    (https://api.moonshot.cn/v1 | moonshot-v1-8k)'
    Write-Host '  [6] 智谱 GLM           (https://open.bigmodel.cn/api/paas/v4 | glm-4-flash)'
    Write-Host '  [7] 本地 Ollama        (http://localhost:11434/v1 | qwen2.5:7b)'
    Write-Host '  [8] 自定义 OpenAI 兼容接口（保留当前地址或手动输入）'
    Write-Host ''

    $presets = @{
        '1' = @{ url = 'https://api.openai.com/v1'; model = 'gpt-4o-mini' }
        '2' = @{ url = 'https://api.deepseek.com'; model = 'deepseek-chat' }
        '3' = @{ url = 'https://openrouter.ai/api/v1'; model = 'openai/gpt-4o-mini' }
        '4' = @{ url = 'https://generativelanguage.googleapis.com/v1beta/openai/'; model = 'gemini-2.5-flash' }
        '5' = @{ url = 'https://api.moonshot.cn/v1'; model = 'moonshot-v1-8k' }
        '6' = @{ url = 'https://open.bigmodel.cn/api/paas/v4'; model = 'glm-4-flash' }
        '7' = @{ url = 'http://localhost:11434/v1'; model = 'qwen2.5:7b' }
    }

    $defaultPreset = '8'
    foreach ($key in $presets.Keys) {
        if ($CurrentMap['LLM_BASE_URL'] -eq $presets[$key].url) {
            $defaultPreset = $key
            break
        }
    }

    $choice = Prompt-WithDefault -Label '输入服务商编号 (1-8)' -DefaultValue $defaultPreset
    if ($presets.ContainsKey($choice)) {
        $selectedUrl = $presets[$choice].url
        $suggestedModel = if ($CurrentMap['LLM_BASE_URL'] -eq $selectedUrl -and -not [string]::IsNullOrWhiteSpace($CurrentMap['LLM_MODEL'])) {
            $CurrentMap['LLM_MODEL']
        } else {
            $presets[$choice].model
        }
    } else {
        $selectedUrl = Prompt-WithDefault -Label '输入兼容 API Base URL' -DefaultValue $CurrentMap['LLM_BASE_URL']
        $suggestedModel = $CurrentMap['LLM_MODEL']
    }

    $selectedModel = Prompt-WithDefault -Label '输入模型名称 (LLM_MODEL)' -DefaultValue $suggestedModel

    # Immediately detect multimodal capability and alert user in console
    $mmCheck = Get-MultimodalInfo -ModelName $selectedModel -OverrideVal 'auto'
    Show-MultimodalNotice -ModelName $selectedModel -Info $mmCheck

    $mmOverrideDefault = if (-not [string]::IsNullOrWhiteSpace($CurrentMap['LLM_MULTIMODAL'])) { $CurrentMap['LLM_MULTIMODAL'] } else { 'auto' }
    $selectedMm = Prompt-WithDefault -Label '多模态开关 (auto / true / false)' -DefaultValue $mmOverrideDefault
    $selectedMmNorm = $selectedMm.ToLowerInvariant()
    if ($selectedMmNorm -notin @('auto', 'true', 'false')) {
        $selectedMmNorm = 'auto'
    }

    # API Key input
    $existingValid = Test-ValidApiKeyLocal -ApiKey $CurrentMap['LLM_API_KEY']
    $selectedKey = ''
    if ($choice -eq '7') {
        $ollamaDefault = if ($existingValid) { $CurrentMap['LLM_API_KEY'] } else { 'ollama' }
        $selectedKey = Prompt-WithDefault -Label '输入 API Key（本地 Ollama 可直接回车）' -DefaultValue $ollamaDefault
    } else {
        while ($true) {
            if ($existingValid) {
                $masked = Get-MaskedKey -ApiKey $CurrentMap['LLM_API_KEY']
                $keyInput = Read-Host "输入 API Key [直接回车保留现有密钥 $masked]"
                if ([string]::IsNullOrWhiteSpace($keyInput)) {
                    $selectedKey = $CurrentMap['LLM_API_KEY']
                    break
                }
                if (Test-ValidApiKeyLocal -ApiKey $keyInput) {
                    $selectedKey = $keyInput.Trim()
                    break
                }
            } else {
                $keyInput = Read-Host '输入你的 API Key（自备 API，必填）'
                if (Test-ValidApiKeyLocal -ApiKey $keyInput) {
                    $selectedKey = $keyInput.Trim()
                    break
                }
            }
            Write-Host '⚠️  请输入有效的 API Key（不能留空或为占位符）。' -ForegroundColor Yellow
        }
    }

    # Forward analysis mode
    $defaultForwardChoice = if ($CurrentMap['FORWARD_AUTO_ANALYZE'] -eq 'false') { '2' } else { '1' }
    Write-Host ''
    Write-Host '转发聊天记录触发方式：' -ForegroundColor White
    Write-Host '  [1] 自动防抖分析（转发后等待数秒自动汇总分析；期间发问题则立即合并分析）'
    Write-Host '  [2] 手动触发分析（转发后先暂存，收到你的问题或 /analyze 指令后分析）'
    $fwdChoice = Prompt-WithDefault -Label '选择转发分析方式 (1-2)' -DefaultValue $defaultForwardChoice
    $forwardAuto = if ($fwdChoice -eq '2') { 'false' } else { 'true' }
    $debounceMs = Prompt-WithDefault -Label '转发聚合防抖时间（毫秒）' -DefaultValue $CurrentMap['FORWARD_DEBOUNCE_MS']

    # Whitelist
    $whitelist = Read-Host ("联系人白名单手机号（逗号分隔，留空则响应所有私聊） [当前: {0}]" -f $(if ([string]::IsNullOrWhiteSpace($CurrentMap['ALLOWED_NUMBERS'])) { '无限制' } else { $CurrentMap['ALLOWED_NUMBERS'] }))
    if ([string]::IsNullOrWhiteSpace($whitelist)) {
        $whitelist = $CurrentMap['ALLOWED_NUMBERS']
    } else {
        $whitelist = $whitelist.Trim()
        if ($whitelist -eq '-' -or $whitelist.ToLowerInvariant() -eq 'none') {
            $whitelist = ''
        }
    }

    # Self-chat
    $defaultSelf = if ($CurrentMap['ENABLE_SELF_CHAT'] -eq 'true') { 'y' } else { 'N' }
    $selfChoice = Prompt-WithDefault -Label '是否开启“给自己发消息（Message Yourself）”自聊模式？(y/N)' -DefaultValue $defaultSelf
    $enableSelfChat = if ($selfChoice.ToLowerInvariant() -eq 'y' -or $selfChoice.ToLowerInvariant() -eq 'true') { 'true' } else { 'false' }

    # Browser auto-detection
    $detectedChrome = Find-BrowserExecutable
    $defaultChrome = if (-not [string]::IsNullOrWhiteSpace($CurrentMap['CHROME_PATH'])) {
        $CurrentMap['CHROME_PATH']
    } else {
        $detectedChrome
    }
    Write-Host ''
    if (-not [string]::IsNullOrWhiteSpace($defaultChrome)) {
        Write-Host "🌐 已检测到本机浏览器：$defaultChrome" -ForegroundColor DarkCyan
        $chromeInput = Read-Host 'Chrome/Edge 路径（直接回车使用以上路径，输入 auto 使用 Puppeteer 内置浏览器）'
        if ([string]::IsNullOrWhiteSpace($chromeInput)) {
            $selectedChrome = $defaultChrome
        } elseif ($chromeInput.Trim().ToLowerInvariant() -eq 'auto') {
            $selectedChrome = ''
        } else {
            $selectedChrome = $chromeInput.Trim().Trim('"')
        }
    } else {
        $chromeInput = Read-Host 'Chrome/Edge 路径（未检测到，直接回车使用 Puppeteer 内置浏览器）'
        $selectedChrome = $chromeInput.Trim().Trim('"')
    }

    $CurrentMap['LLM_API_KEY'] = $selectedKey
    $CurrentMap['LLM_BASE_URL'] = $selectedUrl
    $CurrentMap['LLM_MODEL'] = $selectedModel
    $CurrentMap['LLM_MULTIMODAL'] = $selectedMmNorm
    $CurrentMap['FORWARD_AUTO_ANALYZE'] = $forwardAuto
    $CurrentMap['FORWARD_DEBOUNCE_MS'] = $debounceMs
    $CurrentMap['ALLOWED_NUMBERS'] = $whitelist
    $CurrentMap['ENABLE_SELF_CHAT'] = $enableSelfChat
    $CurrentMap['CHROME_PATH'] = $selectedChrome

    return $CurrentMap
}

function Save-DesktopConfigAndSummary {
    param([System.Collections.Specialized.OrderedDictionary]$ConfigMap)

    New-Item -ItemType Directory -Path $DataDir -Force | Out-Null
    New-Item -ItemType Directory -Path $RecordsDir -Force | Out-Null

    $envLines = @(
        '# WhatsApp AI Assistant — 运行配置（由 whatsapp-assistant.ps1 自动生成）',
        ("# 更新时间: {0}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'))
    )
    foreach ($key in $ConfigMap.Keys) {
        $envLines += ("{0}={1}" -f $key, $ConfigMap[$key])
    }
    [System.IO.File]::WriteAllLines($ConfigEnvPath, $envLines, $utf8NoBom)

    $mmInfo = Get-MultimodalInfo -ModelName $ConfigMap['LLM_MODEL'] -OverrideVal $ConfigMap['LLM_MULTIMODAL']
    $mmLabel = Format-MultimodalStatusLabel -Info $mmInfo
    $forwardLabel = if ($ConfigMap['FORWARD_AUTO_ANALYZE'] -eq 'false') {
        '手动触发 (/analyze)'
    } else {
        "自动防抖分析 ($($ConfigMap['FORWARD_DEBOUNCE_MS'])ms)"
    }
    $whitelistLabel = if ([string]::IsNullOrWhiteSpace($ConfigMap['ALLOWED_NUMBERS'])) {
        '未限制（响应所有私聊）'
    } else {
        $ConfigMap['ALLOWED_NUMBERS']
    }
    $selfChatLabel = if ($ConfigMap['ENABLE_SELF_CHAT'] -eq 'true') { '已开启' } else { '未开启' }
    $chromeLabel = if ([string]::IsNullOrWhiteSpace($ConfigMap['CHROME_PATH'])) { 'Puppeteer 默认缓存浏览器' } else { $ConfigMap['CHROME_PATH'] }

    $summaryLines = @(
        '======================================================================',
        'WhatsApp AI Assistant — 桌面配置与记录档案',
        '======================================================================',
        ("记录时间     : {0}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss')),
        ("项目目录     : {0}" -f $ProjectDir),
        ("API 地址     : {0}" -f $ConfigMap['LLM_BASE_URL']),
        ("当前模型     : {0}" -f $ConfigMap['LLM_MODEL']),
        ("多模态状态   : {0}" -f $mmLabel),
        ("API Key      : {0}" -f (Get-MaskedKey -ApiKey $ConfigMap['LLM_API_KEY'])),
        ("转发分析模式 : {0}" -f $forwardLabel),
        ("联系人白名单 : {0}" -f $whitelistLabel),
        ("自聊模式     : {0}" -f $selfChatLabel),
        ("浏览器路径   : {0}" -f $chromeLabel),
        '----------------------------------------------------------------------',
        '桌面数据文件说明：',
        ("  1. {0}  — 启动配置文件（含 API 密钥，请注意本地保管勿公开分享）" -f $ConfigEnvPath),
        ("  2. {0}  — 本配置信息汇总文件" -f $SetupInfoPath),
        ("  3. {0}  — 各联系人的对话上下文与模式记忆" -f (Join-Path $DataDir 'memory.json')),
        ("  4. {0}\YYYY-MM-DD.md  — 每日聊天记录分析 Markdown 归档" -f $RecordsDir),
        '----------------------------------------------------------------------',
        '免责声明：本工具需自备 API Key；基于非官方 whatsapp-web.js，封号风险自负，建议使用小号。',
        '开源协议：MIT License (by @Azumaserne)'
    )
    [System.IO.File]::WriteAllLines($SetupInfoPath, $summaryLines, $utf8WithBom)

    Write-Host ''
    Write-Host "✅ 已将配置与记录目录保存到桌面：$DataDir" -ForegroundColor Green
    Write-Host "   • 配置文件：$ConfigEnvPath" -ForegroundColor DarkGreen
    Write-Host "   • 信息汇总：$SetupInfoPath" -ForegroundColor DarkGreen
    Write-Host "   • 分析归档：$RecordsDir\YYYY-MM-DD.md" -ForegroundColor DarkGreen
    Write-Host ''
}

# ======================================================================
# Main Entry
# ======================================================================
Write-HeaderBanner

if ($CheckOnly) {
    $nodeCmd = Get-Command node -ErrorAction SilentlyContinue
    $nodeVer = if ($null -ne $nodeCmd) { (& node -v) } else { '未安装' }
    $hasDeps = Test-Path -LiteralPath (Join-Path $ProjectDir 'node_modules')
    $detectedChrome = Find-BrowserExecutable
    $loaded = Resolve-InitialConfigMap
    $mmInfo = Get-MultimodalInfo -ModelName $loaded.Map['LLM_MODEL'] -OverrideVal $loaded.Map['LLM_MULTIMODAL']

    Write-Host '🔍 环境自检模式 (-CheckOnly)：' -ForegroundColor Cyan
    Write-Host "   • Node.js      : $nodeVer"
    Write-Host "   • node_modules : $hasDeps"
    Write-Host "   • 配置来源     : $($loaded.SourceLabel)"
    Write-Host "   • 当前模型     : $($loaded.Map['LLM_MODEL']) ($(Format-MultimodalStatusLabel -Info $mmInfo))"
    Write-Host "   • 检测浏览器   : $(if ([string]::IsNullOrWhiteSpace($detectedChrome)) { '未检测到（将用 Puppeteer 缓存）' } else { $detectedChrome })"
    Write-Host "   • 桌面数据目录 : $DataDir"
    Write-Host "   • 配置文件目标 : $ConfigEnvPath"
    Write-Host "   • 分析归档目录 : $RecordsDir"
    exit 0
}

if (-not (Ensure-NodeInstalled)) {
    Read-Host '按回车键退出...'
    exit 1
}

if (-not (Ensure-DependenciesInstalled)) {
    Read-Host '按回车键退出...'
    exit 1
}

$loadedState = Resolve-InitialConfigMap
$configMap = $loadedState.Map
$hasValidKey = Test-ValidApiKeyLocal -ApiKey $configMap['LLM_API_KEY']

if ($Reconfigure -or -not $hasValidKey) {
    if (-not $hasValidKey) {
        Write-Host '👋 首次运行或尚未填写有效 API Key，现在进入向导配置（全程在本窗口完成）：' -ForegroundColor Yellow
        Write-Host ''
    }
    $configMap = Invoke-InteractiveWizard -CurrentMap $configMap
    Save-DesktopConfigAndSummary -ConfigMap $configMap
} else {
    $mmInfo = Get-MultimodalInfo -ModelName $configMap['LLM_MODEL'] -OverrideVal $configMap['LLM_MULTIMODAL']
    Show-ConfigSummary -ConfigMap $configMap -MultimodalInfo $mmInfo

    while ($true) {
        Write-Host '请选择操作：' -ForegroundColor Cyan
        Write-Host '  [1] 直接启动助手并显示登录二维码（默认回车）'
        Write-Host '  [2] 重新填写 / 修改配置'
        Write-Host '  [3] 打开桌面保存目录（WhatsApp-Assistant-Data）'
        Write-Host '  [4] 退出'
        $menuChoice = Read-Host '请输入选项编号 [默认: 1]'
        if ([string]::IsNullOrWhiteSpace($menuChoice)) {
            $menuChoice = '1'
        } else {
            $menuChoice = $menuChoice.Trim()
        }

        if ($menuChoice -eq '1') {
            Save-DesktopConfigAndSummary -ConfigMap $configMap
            break
        } elseif ($menuChoice -eq '2') {
            $configMap = Invoke-InteractiveWizard -CurrentMap $configMap
            Save-DesktopConfigAndSummary -ConfigMap $configMap
            break
        } elseif ($menuChoice -eq '3') {
            Save-DesktopConfigAndSummary -ConfigMap $configMap
            Start-Process explorer.exe $DataDir
        } elseif ($menuChoice -eq '4') {
            exit 0
        } else {
            Write-Host '⚠️  无效选项，请输入 1-4。' -ForegroundColor Yellow
        }
    }
}

Write-Host '🚀 正在启动 WhatsApp AI 助手，登录二维码将直接显示在下方命令窗口中...' -ForegroundColor Green
Write-Host "   （按 Ctrl + C 可随时停止运行；分析记录将持续写入 $RecordsDir）" -ForegroundColor DarkGray
Write-Host ''

$env:ENV_FILE = $ConfigEnvPath
$env:DATA_DIR = $DataDir

Push-Location $ProjectDir
try {
    & node index.js
    $exitCode = $LASTEXITCODE
} finally {
    Pop-Location
}

Write-Host ''
if ($exitCode -ne 0) {
    Write-Host "⚠️  程序已退出（退出码：$exitCode）。" -ForegroundColor Yellow
} else {
    Write-Host '程序已安全停止。' -ForegroundColor Cyan
}
Read-Host '按回车键退出窗口...'
