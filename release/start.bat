@echo off
echo.
echo ============================================
echo          zcode-proxy Manager
echo ============================================
echo.
echo   1. Start proxy server
echo   2. OAuth login (Bigmodel)
echo   3. OAuth login (Z.AI)
echo   4. Import key from ZCode (Bigmodel)
echo   5. Import key from ZCode (Z.AI)
echo   6. Check login status
echo   7. Logout
echo   0. Exit
echo.
set /p choice=Select: 

if "%choice%"=="1" goto serve
if "%choice%"=="2" goto login_bigmodel
if "%choice%"=="3" goto login_zai
if "%choice%"=="4" goto import_bigmodel
if "%choice%"=="5" goto import_zai
if "%choice%"=="6" goto status
if "%choice%"=="7" goto logout
if "%choice%"=="0" exit
goto end

:serve
echo.
echo Starting proxy server...
echo.
zcode-proxy.exe serve --config config.yaml
pause
goto end

:login_bigmodel
echo.
echo Starting Bigmodel OAuth login...
echo A browser window will open for authorization.
echo.
zcode-proxy.exe auth login bigmodel
pause
goto end

:login_zai
echo.
echo Starting Z.AI OAuth login...
echo A browser window will open for authorization.
echo.
zcode-proxy.exe auth login zai
pause
goto end

:import_bigmodel
echo.
echo Importing key from ZCode (Bigmodel)...
echo.
zcode-proxy.exe auth login bigmodel --import
pause
goto end

:import_zai
echo.
echo Importing key from ZCode (Z.AI)...
echo.
zcode-proxy.exe auth login zai --import
pause
goto end

:status
echo.
zcode-proxy.exe auth status
pause
goto end

:logout
echo.
zcode-proxy.exe auth logout
pause
goto end

:end
