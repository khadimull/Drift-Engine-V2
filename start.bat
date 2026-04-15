@echo off
title Moderator Drift Detection Engine - Setup
color 0A

echo.
echo  ========================================
echo   Moderator Drift Detection Engine
echo   Setup ^& Launch Script (Windows)
echo  ========================================
echo.

:: Check Node.js
where node >nul 2>nul
if %errorlevel% neq 0 (
    echo  [ERROR] Node.js is not installed!
    echo.
    echo  Download it from: https://nodejs.org/
    echo  Install the LTS version, then re-run this script.
    echo.
    pause
    exit /b 1
)

:: Show versions
echo  [OK] Node.js found:
node --version
echo  [OK] npm found:
call npm --version
echo.

:: Install dependencies
echo  [1/2] Installing dependencies...
call npm install
if %errorlevel% neq 0 (
    echo.
    echo  [ERROR] npm install failed. Check your internet connection.
    pause
    exit /b 1
)
echo.
echo  [OK] Dependencies installed.
echo.

:: Run dev server
echo  [2/2] Starting development server...
echo.
echo  ========================================
echo   Dashboard will open at:
echo   http://localhost:3000
echo  ========================================
echo.
echo  Press Ctrl+C to stop the server.
echo.

call npm run dev
