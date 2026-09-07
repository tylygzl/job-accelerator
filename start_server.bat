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

if not exist "requirements-backend.txt" (
    echo [ERROR] requirements-backend.txt not found.
    echo.
    pause
    exit /b 1
)

call :setup_with_python
if not errorlevel 1 (
    goto run_server
)

where uv >nul 2>nul
if not errorlevel 1 (
    call :setup_with_uv
    if not errorlevel 1 goto run_server
)

echo [ERROR] Python was not found.
echo Please install Python 3.10+ or install uv, then try again.
goto failed

:setup_with_uv
if not exist ".venv\Scripts\python.exe" (
    echo Creating .venv with uv...
    uv venv .venv
    if errorlevel 1 exit /b 1
)
echo Installing backend dependencies with uv...
uv pip install -r requirements-backend.txt
if errorlevel 1 exit /b 1
set "PYTHON_EXE=.venv\Scripts\python.exe"
exit /b 0

:setup_with_python
if exist ".venv\Scripts\python.exe" (
    set "PYTHON_EXE=.venv\Scripts\python.exe"
    call :ensure_deps
    exit /b %errorlevel%
)

where py >nul 2>nul
if not errorlevel 1 (
    echo Creating .venv with Python launcher...
    py -3 -m venv .venv
    if errorlevel 1 exit /b 1
    set "PYTHON_EXE=.venv\Scripts\python.exe"
    goto pip_install
)

where python >nul 2>nul
if not errorlevel 1 (
    echo Creating .venv with system Python...
    python -m venv .venv
    if errorlevel 1 exit /b 1
    set "PYTHON_EXE=.venv\Scripts\python.exe"
    goto pip_install
)

exit /b 1

:ensure_deps
"%PYTHON_EXE%" -c "import fastapi, uvicorn, dotenv, langchain_openai, langgraph" >nul 2>nul
if errorlevel 1 goto pip_install
exit /b 0

:pip_install
echo Installing backend dependencies with pip...
"%PYTHON_EXE%" -m pip install -r requirements-backend.txt
if errorlevel 1 exit /b 1
exit /b 0

:run_server
echo.
echo Backend URL: http://127.0.0.1:8000
echo Health check: http://127.0.0.1:8000/health
echo Keep this window open while using the Chrome extension.
echo Press Ctrl+C to stop the backend.
echo.
"%PYTHON_EXE%" server.py
echo.
echo Backend stopped.
pause
exit /b %errorlevel%

:failed
echo.
echo [ERROR] Backend setup failed.
echo Please check your network, Python installation, and API config in .env.
echo.
pause
exit /b 1

:check
echo start_server.bat syntax check OK
exit /b 0
