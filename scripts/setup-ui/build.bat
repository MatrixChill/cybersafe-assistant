@echo off
setlocal
cd /d "%~dp0"
rem NSIS itself is x86 even when its application payload is x64.
set "MSVC=C:\Program Files\Microsoft Visual Studio\18\Community\VC\Tools\MSVC\14.51.36231"
set "SDK=C:\Program Files (x86)\Windows Kits\10"
set "SDKV=10.0.26100.0"
set "PATH=%MSVC%\bin\Hostx64\x86;%PATH%"
set "INCLUDE=%MSVC%\include;%SDK%\Include\%SDKV%\ucrt;%SDK%\Include\%SDKV%\um;%SDK%\Include\%SDKV%\shared"
set "LIB=%MSVC%\lib\x86;%SDK%\Lib\%SDKV%\ucrt\x86;%SDK%\Lib\%SDKV%\um\x86"
if not exist "..\..\output\setup-ui" mkdir "..\..\output\setup-ui"
if not exist "..\..\packages\desktop\build\x86-unicode" mkdir "..\..\packages\desktop\build\x86-unicode"
cl /nologo /EHsc /O2 /MT /std:c++17 /utf-8 /LD /Fo"..\..\output\setup-ui\main.obj" main.cpp /link user32.lib gdi32.lib gdiplus.lib shell32.lib shlwapi.lib bcrypt.lib /DYNAMICBASE /NXCOMPAT /DEF:exports.def /IMPLIB:"..\..\output\setup-ui\OrbitalSetup.lib" /OUT:"..\..\packages\desktop\build\x86-unicode\OrbitalSetup.dll"
exit /b %errorlevel%
