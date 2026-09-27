@echo off
chcp 65001 >nul
cd /d "%~dp0"
title Article to Knowledge Cards
echo.
echo  文章转知识卡片 —— 正在启动
echo  ---------------------------------------------
echo.

if not exist ".env" (
  echo  [错误] 找不到 .env 配置文件。
  echo.
  echo  请先执行：copy .env.example .env
  echo  然后编辑 .env 填入 LLM_API_KEY。
  echo.
  pause
  exit /b 1
)

if not exist "prompt-skill.md" (
  echo  [提示] 缺少 prompt-skill.md，正在从 SKILL.md 同步...
  node sync-prompt.mjs
  echo.
)

echo  服务启动后，用浏览器打开： http://127.0.0.1:8787
echo  按 Ctrl+C 可停止服务。
echo.

node server.js

echo.
echo  服务已停止。
pause
