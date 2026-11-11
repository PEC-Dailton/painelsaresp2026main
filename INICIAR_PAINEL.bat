@echo off
setlocal
cd /d "%~dp0"

where python >nul 2>nul
if errorlevel 1 goto python_missing

python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/api/status', timeout=2)" >nul 2>nul
if not errorlevel 1 goto open_panel

start "Painel SARESP - Servidor" cmd /k "cd /d ""%~dp0"" && python server.py"
timeout /t 2 /nobreak >nul

:open_panel
start "" "http://127.0.0.1:8000/"
exit /b 0

:python_missing
echo Python nao foi encontrado. Instale o Python 3 e tente novamente.
pause
exit /b 1
