@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if %errorlevel% neq 0 (
    echo [错误] 未检测到 Node.js，请先安装 Node.js 18 LTS 或更高版本：
    echo        https://nodejs.org/
    pause
    exit /b 1
)

if not exist "node_modules" (
    echo [提示] 未检测到 node_modules，请先在此目录运行：
    echo        npm install
    pause
    exit /b 1
)

if not exist ".env" (
    echo [提示] 未检测到 .env 配置文件！
    echo        请先复制 .env.example 为 .env 并填入你自己的 API Key。
    pause
    exit /b 1
)

node index.js
pause
