@echo off
title EVOO Besu QBFT experiment
echo Four-validator Besu QBFT experiment, native Windows. Keep this window open (about 15-20 minutes).
echo Progress is written to run.log in this folder.
echo.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0run-besu-experiment.ps1"
echo.
echo Finished. Status:
type "%~dp0STATUS"
pause
