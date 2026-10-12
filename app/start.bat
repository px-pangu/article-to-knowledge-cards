@echo off
rem ===============================================================
rem  文章转知识卡片 —— 启动脚本
rem
rem  [!] 本文件必须保持 GBK(cp936) 编码 + CRLF 换行，请勿改成 UTF-8。
rem      实测：cmd.exe 读取 UTF-8 的 .bat 时，因多字节字符导致字节偏移
rem      错乱，会把后续命令行从中间截断，产生大量
rem      「'xxx' 不是内部或外部命令」报错；加 chcp 65001 也无效，
rem      带 BOM 更会连 @echo off 都失效。只有 GBK + CRLF 正常。
rem      若需修改，改完务必转回 GBK 编码再保存。
rem ===============================================================
cd /d "%~dp0"
title 文章转知识卡片
echo.
echo  文章转知识卡片 —— 正在启动
echo  ---------------------------------------------
echo.

rem ---------------------------------------------------------------
rem  定位 Node.js
rem  本机系统 PATH 中没有 node（Node 由 WorkBuddy 内置提供），
rem  直接写 node 会报「不是内部或外部命令」，因此必须显式查找。
rem ---------------------------------------------------------------
set "NODE_EXE="

rem 1) 优先用系统 PATH 里的 node
for /f "delims=" %%i in ('where node 2^>nul') do (
  if not defined NODE_EXE set "NODE_EXE=%%i"
)

rem 2) WorkBuddy 内置的 node（取版本目录中字母序最后一个）
if not defined NODE_EXE (
  for /d %%v in ("%USERPROFILE%\.workbuddy\binaries\node\versions\*") do (
    if exist "%%~fv\node.exe" set "NODE_EXE=%%~fv\node.exe"
  )
)

rem 3) 常规安装位置
if not defined NODE_EXE (
  if exist "%ProgramFiles%\nodejs\node.exe" set "NODE_EXE=%ProgramFiles%\nodejs\node.exe"
)
if not defined NODE_EXE (
  if exist "%ProgramFiles(x86)%\nodejs\node.exe" set "NODE_EXE=%ProgramFiles(x86)%\nodejs\node.exe"
)

if not defined NODE_EXE (
  echo  [错误] 找不到 Node.js。
  echo.
  echo  本应用需要 Node.js 18 或更高版本，已查找下列位置：
  echo    - 系统 PATH
  echo    - %USERPROFILE%\.workbuddy\binaries\node\versions\
  echo    - Program Files\nodejs
  echo.
  echo  请先安装 Node.js： https://nodejs.org/
  echo.
  pause
  exit /b 1
)

echo  Node： %NODE_EXE%
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
  "%NODE_EXE%" sync-prompt.mjs
  echo.
)

echo  服务启动后，浏览器会自动打开： http://127.0.0.1:8787
echo  按 Ctrl+C 可停止服务。
echo.

rem ---------------------------------------------------------------
rem  启动 node 前做两件事：
rem    1) set OPEN_BROWSER=1 —— 服务就绪后自动打开浏览器
rem    2) chcp 65001        —— node 按 UTF-8 输出，而控制台默认是
rem                            GBK(936)，不切页 node 的中文就是乱码
rem  [!] 从切页到切回之间，本文件只能出现 ASCII 字符 ——
rem      那些行会被按 UTF-8 解析，若含 GBK 中文就会解析错乱。
rem ---------------------------------------------------------------
set "OPEN_BROWSER=1"
chcp 65001 >nul
"%NODE_EXE%" server.js

chcp 936 >nul
echo.
echo  服务已停止，按任意键关闭窗口。
pause
