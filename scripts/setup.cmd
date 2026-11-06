@echo off
rem Fono Console setup launcher: runs setup.ps1 without changing your execution policy.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup.ps1" %*
pause
