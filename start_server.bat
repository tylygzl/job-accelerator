@echo off
setlocal

title Job Accelerator Backend
cd /d "%~dp0"

if "%~1"=="--check" goto check

echo ========================================
echo Job Accelerator Backend
echo ========================================
echo.

if not exist "server.py" (
    echo [ERROR] server.py not found. Please run this script from the project folder.
    echo.
    pause
    exit /b 1
)

if not exist ".env" (
    echo [WARN] .env not found.
    if exist ".env.example" (
        copy ".env.example" ".env" >nul
        echo Created .env from .env.example.
        echo Please open .env, fill your own LLM_API_KEY / LLM_MODEL, then double-click this script again.
    ) else (
        echo Please create .env and configure your LLM API key first.
    )
    echo.
    pause
    exit /b 1
)

echo Backend URL: http://127.0.0.1:8000
echo Health check: http://127.0.0.1:8000/health
echo Keep this window open while using the Chrome extension.
echo Press Ctrl+C to stop the backend.
echo.

where uv >nul 2>nul
if not errorlevel 1 (
    echo Starting with uv...
    uv run python server.py
    goto done
)

if exist ".venv\Scripts\python.exe" (
    echo Starting with .venv Python...
    ".venv\Scripts\python.exe" server.py
    goto done
)

where py >nul 2>nul
if not errorlevel 1 (
    echo Starting with Python launcher...
    py -3 server.py
    goto done
)

where python >nul 2>nul
if not errorlevel 1 (
    echo Starting with system Python...
    python server.py
    goto done
)

echo [ERROR] Python was not found.
echo Please install Python 3.13+ or install uv, then try again.
echo.
pause
exit /b 1

:done
echo.
echo Backend stopped.
pause
exit /b %errorlevel%

:check
echo start_server.bat syntax check OK
exit /b 0
