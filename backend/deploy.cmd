@echo off
rem ============================================================
rem ASI Workbench 一键部署脚本（每次代码更新后运行）
rem 流程：停旧服务 -> 构建 -> 提交并推送 GitHub（触发 Render 自动部署）
rem       -> 启动本地服务 -> 健康检查
rem 用法：deploy.cmd  （或双击运行）
rem ============================================================
setlocal enabledelayedexpansion
cd /d C:\Users\Administrator\Desktop\asi-workbench-repo\backend

set PORT=4100

echo [1/5] 停止旧服务（端口 %PORT%）...
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":%PORT%" ^| findstr "LISTENING"') do (
    taskkill /PID %%a /F >nul 2>&1 && echo     已停止 PID %%a
)

echo [2/5] 构建 TypeScript...
call npm run build
if errorlevel 1 (
    echo     [错误] 构建失败，已中止（不推送、不启动）
    exit /b 1
)
echo     构建完成

echo [3/5] 提交并推送 GitHub（触发 Render 自动部署）...
cd /d C:\Users\Administrator\Desktop\asi-workbench-repo
git add -A
git diff --cached --quiet
if errorlevel 1 (
    for /f %%i in ('powershell -NoProfile -Command "Get-Date -Format yyyy-MM-dd HH:mm"') do set ts=%%i
    git commit -m "deploy: 本地验证通过自动提交 !ts!"
    if errorlevel 1 (
        echo     [错误] git commit 失败，请检查
        exit /b 1
    )
    git push origin main
    if errorlevel 1 (
        echo     [错误] git push 失败，Render 未触发部署
        exit /b 1
    )
    echo     已推送，Render 正在自动部署（可在 Render 控制台查看进度）
) else (
    echo     无代码改动，跳过推送
)

echo [4/5] 启动本地服务（用于本地验证）...
cd /d C:\Users\Administrator\Desktop\asi-workbench-repo\backend
set NODE_ENV=production
set PORT=%PORT%
start "asi-backend" /min cmd /c "node dist/index.js"

echo [5/5] 健康检查...
set /a tries=0
:wait_health
timeout /t 2 /nobreak >nul
curl -s -m 3 http://localhost:%PORT%/api/health > "%TEMP%\asi-health.json" 2>nul
findstr /c:"ok" "%TEMP%\asi-health.json" >nul 2>&1
if %errorlevel%==0 goto healthy
set /a tries+=1
if %tries% lss 10 goto wait_health
echo     [错误] 本地服务启动失败（不影响 Render 部署，请检查 dist/index.js）
exit /b 1

:healthy
echo     本地服务正常: http://localhost:%PORT%
type "%TEMP%\asi-health.json"
echo.
echo 部署完成（本地运行中 + Render 自动部署中）
exit /b 0
