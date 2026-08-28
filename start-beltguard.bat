@echo off
setlocal enabledelayedexpansion
title PRAVAAH - conveyor integrity

rem ===========================================================================
rem  PRAVAAH launcher (file name kept: shortcuts and docs point at it)
rem  Double-click this on the factory laptop. It checks the toolchain, installs
rem  dependencies the first time, prints the address the ESP32 must publish to,
rem  and starts the gateway.
rem
rem  Optional switches:
rem     start-beltguard.bat /noopen     do not open the browser
rem     start-beltguard.bat /bench      also start the wire-protocol test
rem                                     harness (synthetic frames - NOT sensor
rem                                     data; see README section 9)
rem ===========================================================================

cd /d "%~dp0"

set OPEN=1
set BENCH=0
for %%a in (%*) do (
    if /i "%%~a"=="/noopen" set OPEN=0
    if /i "%%~a"=="/bench"  set BENCH=1
)

echo.
echo   ===========================================================
echo     B E L T G U A R D   E D G E
echo     PRAVAAH - conveyor joint and damage monitoring - SIH26008
echo   ===========================================================
echo.

rem --------------------------------------------------------------- node check
where node >nul 2>&1
if errorlevel 1 (
    echo   [X] Node.js was not found on this machine.
    echo.
    echo       Install the LTS build from https://nodejs.org  ^(v22.5 or newer^),
    echo       then run this file again.
    echo.
    pause
    exit /b 1
)

for /f "tokens=1 delims=." %%v in ('node -p "process.versions.node"') do set NODEMAJOR=%%v
if %NODEMAJOR% LSS 22 (
    node -v > "%TEMP%\bg_nodever.txt"
    set /p FOUNDVER=<"%TEMP%\bg_nodever.txt"
    del "%TEMP%\bg_nodever.txt" >nul 2>&1
    echo   [X] Node !FOUNDVER! is too old.
    echo.
    echo       The database uses the built-in node:sqlite module, which needs
    echo       Node 22.5 or newer. Upgrade from https://nodejs.org
    echo.
    pause
    exit /b 1
)

for /f %%v in ('node -v') do echo   [ok] Node %%v

rem ------------------------------------------------------------- dependencies
if not exist "node_modules\aedes\" (
    echo   [..] First run - installing dependencies. This takes a minute.
    echo.
    call npm install --no-audit --no-fund
    if errorlevel 1 (
        echo.
        echo   [X] npm install failed. Check the network connection and retry.
        echo.
        pause
        exit /b 1
    )
    echo.
)
echo   [ok] Dependencies present

rem ------------------------------------------------- address for sensor nodes
echo.
echo   ---------------------------------------------------------------
echo    Point the ESP32 at ONE of these addresses:
echo.
for /f "tokens=2 delims=:" %%a in ('ipconfig ^| findstr /c:"IPv4 Address"') do (
    set IPADDR=%%a
    set IPADDR=!IPADDR: =!
    echo        #define MQTT_HOST "!IPADDR!"
)
echo.
echo    Dashboard   http://localhost:8811
echo    MQTT broker port 1883
echo.
echo    If a node cannot connect, the firewall rules are probably missing.
echo    Run these ONCE in an Administrator prompt:
echo.
echo      netsh advfirewall firewall add rule name="PRAVAAH MQTT" dir=in action=allow protocol=TCP localport=1883
echo      netsh advfirewall firewall add rule name="PRAVAAH HTTP" dir=in action=allow protocol=TCP localport=8811
echo   ---------------------------------------------------------------
echo.

rem ------------------------------------------------------------------- launch
rem Give the server ~3s to bind before the browser asks for the page.
rem `ping` rather than `timeout`, because timeout.exe refuses to run whenever
rem stdin is redirected; and fully-qualified paths, because this machine may
rem have Git-for-Windows or MSYS tools ahead of System32 on PATH.
if "%OPEN%"=="1" (
    start "" /b cmd /c ""%SystemRoot%\System32\ping.exe" -n 4 127.0.0.1 >nul & "%SystemRoot%\explorer.exe" http://localhost:8811"
)

if "%BENCH%"=="1" (
    echo   [!] Starting the BENCH HARNESS in a second window.
    echo       Its numbers are synthetic and mean nothing about any belt.
    echo       Close that window and delete data\beltguard.db before you
    echo       capture anything from the real rig.
    echo.
    start "PRAVAAH BENCH HARNESS - synthetic data" cmd /k node tools\bench-publisher.js
)

echo   Starting gateway. Press Ctrl+C to stop.
echo.
node server\index.js

rem --------------------------------------------------------------- exit paths
set EXITCODE=%ERRORLEVEL%
echo.
rem 0 = clean shutdown. 130 / 143 / -1073741510 are Ctrl+C and terminate,
rem which are also normal ways to stop it - not faults worth alarming about.
if "%EXITCODE%"=="0"           goto :stopped
if "%EXITCODE%"=="130"         goto :stopped
if "%EXITCODE%"=="143"         goto :stopped
if "%EXITCODE%"=="-1073741510" goto :stopped

echo   [X] The gateway stopped with exit code %EXITCODE%.
echo.
echo       Most likely causes:
echo         - port 8811 or 1883 already in use ^(another copy running?^)
echo         - data\beltguard.db is open in another program
echo       The lines above this banner carry the actual error.
goto :done

:stopped
echo   Gateway stopped.

:done
echo.
pause
endlocal
