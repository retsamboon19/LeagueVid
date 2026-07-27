@echo off
setlocal enabledelayedexpansion
cd /d "%~dp0"

echo ================================================
echo   LeagueVid - First-time setup
echo ================================================
echo.
echo This will check for the tools LeagueVid needs,
echo install its dependencies, and help you set up
echo your Riot API key. You only need to run this once.
echo.
pause

:: --- 1. Check for Node.js -----------------------------------------------
echo.
echo [1/3] Checking for Node.js...
where node >nul 2>nul
if errorlevel 1 (
    echo.
    echo   Node.js was not found on your computer.
    echo   LeagueVid needs it to run.
    echo.
    echo   Opening the download page for you now.
    echo   Download the "LTS" version, install it with the
    echo   default options, then run this setup.bat again.
    echo.
    start https://nodejs.org/
    pause
    exit /b 1
)
echo   Node.js found: OK
node -v

:: --- 2. Install dependencies ---------------------------------------------
echo.
echo [2/3] Installing LeagueVid's dependencies...
echo   (this can take a few minutes the first time, please wait)
echo.
call npm install
if errorlevel 1 (
    echo.
    echo   Something went wrong while installing dependencies.
    echo   Scroll up to see the error message above.
    echo.
    pause
    exit /b 1
)

:: --- 3. Riot API key -------------------------------------------------------
echo.
echo [3/3] Riot API key setup
echo.
if exist ".env" (
    echo   A .env file already exists, skipping this step.
    echo   ^(You can still set or change your key later from
    echo   the app's Settings screen.^)
) else (
    echo   LeagueVid needs a Riot API key to look up your matches.
    echo.
    echo   1. Opening the Riot Developer Portal for you now.
    echo   2. Log in and copy the key shown as "Development API Key".
    echo   3. Come back here and paste it below.
    echo.
    echo   ^(You can skip this and paste it into the app's Settings
    echo   screen instead - just press Enter to skip.^)
    echo.
    start https://developer.riotgames.com/
    set /p RIOT_KEY="Paste your Riot API key here, then press Enter: "
    if "!RIOT_KEY!"=="" (
        copy /y ".env.example" ".env" >nul
        echo   Skipped. A blank .env was created - add your key in
        echo   Settings once the app is open.
    ) else (
        echo RIOT_API_KEY=!RIOT_KEY!> ".env"
        echo   Saved your key to .env
    )
)

echo.
echo ================================================
echo   Setup complete!
echo ================================================
echo.
echo   From now on, just double-click "run-dev.bat"
echo   to start LeagueVid.
echo.
set /p LAUNCH_NOW="Start LeagueVid now? (Y/N): "
if /i "!LAUNCH_NOW!"=="Y" (
    call run-dev.bat
) else (
    echo   OK. Double-click run-dev.bat any time to launch it.
    pause
)
