@echo off
rem Native setup UI build. Environment pinned explicitly: vcvars64.bat is slow
rem under this shell and its output redirect gets rewritten by the MSYS layer.
set "MSVC=C:\Program Files\Microsoft Visual Studio\18\Community\VC\Tools\MSVC\14.51.36231"
set "SDK=C:\Program Files (x86)\Windows Kits\10"
set "SDKV=10.0.26100.0"
set "PATH=%MSVC%\bin\Hostx64\x64;%PATH%"
set "INCLUDE=%MSVC%\include;%SDK%\Include\%SDKV%\ucrt;%SDK%\Include\%SDKV%\um;%SDK%\Include\%SDKV%\shared"
set "LIB=%MSVC%\lib\x64;%SDK%\Lib\%SDKV%\ucrt\x64;%SDK%\Lib\%SDKV%\um\x64"
cl /nologo /EHsc /O2 /std:c++17 /DUNICODE /D_UNICODE main.cpp /link user32.lib gdi32.lib gdiplus.lib /SUBSYSTEM:WINDOWS /OUT:CyberSafeSetupUI.exe
