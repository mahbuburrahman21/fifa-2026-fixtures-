@echo off
title World Cup 2026 - Fixtures ^& Live Stream
cd /d "%~dp0"
start "" http://localhost:8000
python server\server.py
pause
