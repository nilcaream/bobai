@echo off
setlocal enabledelayedexpansion

:: Bob AI installer — Windows x86_64 (CMD)
:: Usage:
::   One-liner:  curl -fsSL https://raw.githubusercontent.com/nilcaream/bobai/main/install/win32-x64-native.cmd -o %TEMP%\bobai-install.cmd && %TEMP%\bobai-install.cmd
::   From clone: install\win32-x64-native.cmd

set "BUN_VERSION=1.3.3"
set "BUN_SHA256=53e239b058c13f0bb70949b222c4d40c5ab7d6cad22268b2ace2187fcfd7a247"
set "BUN_ARCHIVE=bun-windows-x64.zip"
set "BUN_EXTRACT_DIR=bun-windows-x64"
set "BOBAI_PLATFORM=win32-x64-native"
set "BUN_URL=https://github.com/oven-sh/bun/releases/download/bun-v%BUN_VERSION%/%BUN_ARCHIVE%"
set "RELEASE_ARCHIVE=bobai-%BOBAI_PLATFORM%.zip"
set "RELEASE_URL=https://github.com/nilcaream/bobai/releases/latest/download/%RELEASE_ARCHIVE%"

set "BOBAI_HOME=%LOCALAPPDATA%\bobai"
set "BUN_EXE=%BOBAI_HOME%\bun.exe"
set "BIN_DIR=%BOBAI_HOME%\bin"
set "DIST_DIR=%BOBAI_HOME%\dist"
set "TMP_DIR="

echo [INFO]  Installing Bob AI for Windows...

call :install_bun    || goto :error
call :fetch_release  || goto :error
call :deploy_dist    || goto :error
call :install_runner || goto :error

echo.
echo Bob AI installed successfully!
echo.
echo   Authenticate:  bobai auth
echo   Start:         bobai
echo.

call :assert_on_path
call :do_cleanup
exit /b 0

:error
echo.
echo [ERROR] Installation failed!
echo.
call :do_cleanup
exit /b 1

:: ── Helpers ────────────────────────────────────────────────────────

:log_info
echo [INFO]  %*
goto :eof

:log_error
echo [ERROR] %*
goto :eof

:do_cleanup
if defined TMP_DIR (
    if exist "%TMP_DIR%" rmdir /s /q "%TMP_DIR%" 2>nul
)
goto :eof

:: ── Bun install ────────────────────────────────────────────────────

:install_bun
if not exist "%BOBAI_HOME%" mkdir "%BOBAI_HOME%"

if not exist "%BUN_EXE%" goto :download_bun

for /f "tokens=*" %%v in ('"%BUN_EXE%" --version 2^>nul') do set "CUR_VER=%%v"
if "%CUR_VER%"=="%BUN_VERSION%" (
    call :log_info Bun %BUN_VERSION% already installed.
    goto :eof
)
call :log_info Bun version mismatch (have %CUR_VER%, need %BUN_VERSION%). Updating...

:download_bun
set "TMP_ZIP=%BOBAI_HOME%\bun-download.zip"
call :log_info Downloading Bun %BUN_VERSION%...
powershell -Command "$ProgressPreference='SilentlyContinue'; Invoke-WebRequest -Uri '%BUN_URL%' -OutFile '%TMP_ZIP%'"
if errorlevel 1 (call :log_error Download failed. & exit /b 1)

call :log_info Verifying checksum...
call :verify_sha256 "%TMP_ZIP%" "%BUN_SHA256%"
if errorlevel 1 (
    del /f "%TMP_ZIP%" 2>nul
    call :log_error Checksum mismatch.
    exit /b 1
)

set "TMP_EXTRACT=%BOBAI_HOME%\bun-extract"
if exist "%TMP_EXTRACT%" rmdir /s /q "%TMP_EXTRACT%"
powershell -Command "Expand-Archive -Path '%TMP_ZIP%' -DestinationPath '%TMP_EXTRACT%' -Force"
if errorlevel 1 (call :log_error Extraction failed. & exit /b 1)

move /y "%TMP_EXTRACT%\%BUN_EXTRACT_DIR%\bun.exe" "%BUN_EXE%" >nul
if errorlevel 1 (call :log_error Failed to move bun.exe. & exit /b 1)

if exist "%TMP_EXTRACT%" rmdir /s /q "%TMP_EXTRACT%"
del /f "%TMP_ZIP%" 2>nul
call :log_info Bun %BUN_VERSION% installed.
goto :eof

:: ── SHA256 verification (certutil) ─────────────────────────────────

:verify_sha256
set "ZIP_FILE=%~1"
set "EXPECTED=%~2"
set "HASH_LINE="

for /f "skip=1 tokens=*" %%h in ('certutil -hashfile "%ZIP_FILE%" SHA256 2^>nul') do (
    set "HASH_LINE=%%h"
    goto :got_hash
)
:got_hash

if /i "!HASH_LINE!"=="%EXPECTED%" exit /b 0

call :log_error Expected: %EXPECTED%
call :log_error Got:      !HASH_LINE!
exit /b 1

:: ── Fetch release ──────────────────────────────────────────────────

:fetch_release
for /f "tokens=*" %%g in ('powershell -Command "[System.Guid]::NewGuid().ToString()"') do set "GUID=%%g"
set "TMP_DIR=%TEMP%\bobai-install-%GUID%"
mkdir "%TMP_DIR%"

call :log_info Downloading Bob AI release...
set "TMP_ZIP=%TMP_DIR%\bobai.zip"
powershell -Command "$ProgressPreference='SilentlyContinue'; Invoke-WebRequest -Uri '%RELEASE_URL%' -OutFile '%TMP_ZIP%'"
if errorlevel 1 (call :log_error Download failed. & exit /b 1)

call :log_info Unpacking...
powershell -Command "Expand-Archive -Path '%TMP_ZIP%' -DestinationPath '%TMP_DIR%' -Force"
if errorlevel 1 (call :log_error Extraction failed. & exit /b 1)

del /f "%TMP_ZIP%" 2>nul
goto :eof

:: ── Deploy ─────────────────────────────────────────────────────────

:deploy_dist
if exist "%DIST_DIR%" rmdir /s /q "%DIST_DIR%"
mkdir "%DIST_DIR%\ui"

copy /y "%TMP_DIR%\dist\server.js" "%DIST_DIR%\server.js" >nul
if errorlevel 1 (call :log_error Failed to copy server.js. & exit /b 1)

xcopy /e /y "%TMP_DIR%\dist\ui\*" "%DIST_DIR%\ui\" >nul
if errorlevel 1 (call :log_error Failed to copy UI dist. & exit /b 1)

call :log_info Dist deployed to %DIST_DIR%
goto :eof

:: ── Runner ─────────────────────────────────────────────────────────

:install_runner
set "BUILD_VERSION=unknown"
if exist "%TMP_DIR%\VERSION" (
    set /p BUILD_VERSION=<"%TMP_DIR%\VERSION"
)

if not exist "%BIN_DIR%" mkdir "%BIN_DIR%"
set "RUNNER=%BIN_DIR%\bobai.cmd"

(
    echo @echo off
    echo setlocal
    echo if "%%1"=="update" (
    echo     echo Updating Bob AI...
    echo     powershell -Command "& { Invoke-WebRequest -UseBasicParsing -Uri 'https://raw.githubusercontent.com/nilcaream/bobai/main/install/win32-x64-native.ps1' | Invoke-Expression }"
    echo     exit /b 0
    echo ^)
    echo set "BOBAI_HOME=%%LOCALAPPDATA%%\bobai"
    echo echo Bob AI %BUILD_VERSION%
    echo set BUN_CONFIG_INSTALL_AUTO=disable
    echo set BOBAI_VERSION=%BUILD_VERSION%
    echo set BOBAI_PLATFORM=%BOBAI_PLATFORM%
    echo "%%BOBAI_HOME%%\bun.exe" "%%BOBAI_HOME%%\dist\server.js" %%*
    echo endlocal
) > "%RUNNER%"

call :log_info Runner installed at %RUNNER%
goto :eof

:: ── PATH check ─────────────────────────────────────────────────────

:assert_on_path
echo %PATH% | findstr /i /c:"%BIN_DIR%" >nul 2>nul
if errorlevel 1 (
    echo Note: %BIN_DIR% is not on your PATH.
    echo Add it via System Properties ^> Environment Variables, or run:
    echo.
    echo   setx PATH "%%PATH%%;%BIN_DIR%"
    echo.
)
goto :eof
