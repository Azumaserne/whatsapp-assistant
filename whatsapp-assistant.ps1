[CmdletBinding()]
param(
    [switch]$Reconfigure,
    [switch]$CheckOnly,
    [string]$Lang = ''
)

$ErrorActionPreference = 'Stop'

try {
    $utf8NoBom = [System.Text.UTF8Encoding]::new($false)
    $OutputEncoding = $utf8NoBom
    [Console]::InputEncoding = $utf8NoBom
    [Console]::OutputEncoding = $utf8NoBom
    chcp 65001 | Out-Null
    $Host.UI.RawUI.WindowTitle = 'WhatsApp AI Assistant (@Azumaserne)'
} catch {
    # Ignore console encoding failures in non-interactive hosts
}

$ProjectDir = $PSScriptRoot

function Ensure-NodeInstalled {
    $nodeCmd = Get-Command node -ErrorAction SilentlyContinue
    if ($null -ne $nodeCmd) {
        return $true
    }

    Write-Host '❌ Node.js (18 LTS+) was not found / 未检测到 Node.js！' -ForegroundColor Red
    $wingetCmd = Get-Command winget -ErrorAction SilentlyContinue
    if ($null -ne $wingetCmd) {
        $installChoice = Read-Host 'Install Node.js LTS via winget now? / 使用 winget 自动安装？(Y/n)'
        if ([string]::IsNullOrWhiteSpace($installChoice) -or $installChoice.Trim().ToLowerInvariant() -eq 'y') {
            & winget install -e --id OpenJS.NodeJS.LTS --accept-package-agreements --accept-source-agreements
            $env:Path = [System.Environment]::GetEnvironmentVariable('Path', 'Machine') + ';' + [System.Environment]::GetEnvironmentVariable('Path', 'User')
            $nodeCmd = Get-Command node -ErrorAction SilentlyContinue
            if ($null -ne $nodeCmd) {
                return $true
            }
        }
    }

    Write-Host 'Download Node.js 18+ LTS: https://nodejs.org/' -ForegroundColor Yellow
    return $false
}

function Ensure-DependenciesInstalled {
    $nodeModulesDir = Join-Path $ProjectDir 'node_modules'
    if (Test-Path -LiteralPath $nodeModulesDir) {
        return $true
    }

    Write-Host '📦 Installing dependencies (npm install)...' -ForegroundColor Cyan
    Push-Location $ProjectDir
    try {
        & npm install
        if ($LASTEXITCODE -ne 0) {
            return $false
        }
        return $true
    } finally {
        Pop-Location
    }
}

if (-not (Ensure-NodeInstalled)) {
    if (-not $CheckOnly) {
        Read-Host 'Press Enter to exit / 按回车键退出...'
    }
    exit 1
}

if (-not $CheckOnly) {
    if (-not (Ensure-DependenciesInstalled)) {
        Read-Host 'Press Enter to exit / 按回车键退出...'
        exit 1
    }
}

$cliArgs = @()
if ($CheckOnly) {
    $cliArgs += '--check-only'
}
if ($Reconfigure) {
    $cliArgs += '--reconfigure'
}
if (-not [string]::IsNullOrWhiteSpace($Lang)) {
    $cliArgs += '--lang'
    $cliArgs += $Lang.Trim()
}

& node (Join-Path $ProjectDir 'src\cli.js') @cliArgs
$exitCode = $LASTEXITCODE
if (-not $CheckOnly -and $exitCode -ne 0) {
    Read-Host 'Press Enter to exit / 按回车键退出...'
}
exit $exitCode
