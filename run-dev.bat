@echo off
cd /d "%~dp0"
echo Starting LeagueVid (dev mode)...
echo.
call npm run dev
echo.
echo ============================================
echo App exited. Check the output above for errors.
echo ============================================
pause
