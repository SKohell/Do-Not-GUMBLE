@echo off
chcp 65001 >nul
title 金融肉鸽 · 黄金赌鸽所
where node >nul 2>nul
if %errorlevel%==0 (
  node "%~dp0server.js"
) else (
  "C:\Users\shishuoyu\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe" "%~dp0server.js"
)
pause