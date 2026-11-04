; Orbital B Win32 is the interactive frontend; electron-builder remains the engine.
; Previous MUI integration is preserved in cybersafe-installer.nsh (not selected).
!ifndef BUILD_UNINSTALLER
!include LogicLib.nsh
!include FileFunc.nsh
!define CS_ORBITAL_ROOT "${BUILD_RESOURCES_DIR}\..\..\.."
!addplugindir /x86-unicode "${BUILD_RESOURCES_DIR}\x86-unicode"
Var CSOrbitalActive
Var CSOrbitalVerified
Var CSOrbitalExecutable
Var CSOrbitalDesktop
Var CSOrbitalMenu
Var CSOrbitalAction
Var CSOrbitalSavedDir
Var CSOrbitalRegisteredDir
Var CSOrbitalTrace

; Keep one trace per attempt outside the installation tree and plugin temp.
; Record fixed stage labels only: no profile paths, credentials or options.
!macro CSOrbitalTrace MESSAGE
  Push $9
  ClearErrors
  FileOpen $9 "$CSOrbitalTrace" a
  ${IfNot} ${Errors}
    FileSeek $9 0 END
    FileWrite $9 "${MESSAGE}$\r$\n"
    FileClose $9
  ${EndIf}
  Pop $9
  ClearErrors
!macroend

!macro customInit
  StrCpy $CSOrbitalActive 0
  StrCpy $CSOrbitalVerified 0
  ; /S is owned by the verified launcher/updater: no UI, no option overrides.
  ${IfNot} ${Silent}
    StrCpy $CSOrbitalActive 1
    CreateDirectory "$TEMP\CyberSafe-Setup-Logs"
    GetTempFileName $CSOrbitalTrace "$TEMP\CyberSafe-Setup-Logs"
    !insertmacro CSOrbitalTrace "orbital-start version=${VERSION}"
    InitPluginsDir
    SetOutPath "$PLUGINSDIR\assets\branding\scene"
    File "${CS_ORBITAL_ROOT}\assets\branding\scene\orbital-b-scene.png"
    SetOutPath "$PLUGINSDIR\assets\branding\source"
    File "${CS_ORBITAL_ROOT}\assets\branding\source\07_CyberSafe_horizontal_lockup.png"
    File "${CS_ORBITAL_ROOT}\assets\branding\source\symbol.png"
    SetOutPath "$PLUGINSDIR\assets\branding\icon"
    File "${CS_ORBITAL_ROOT}\assets\branding\icon\cybersafe.ico"
    File "/oname=$PLUGINSDIR\THIRD-PARTY-NOTICES.txt" "${CS_ORBITAL_ROOT}\assets\licenses\THIRD-PARTY-NOTICES.txt"
    StrCpy $CSOrbitalRegisteredDir ""
    !ifndef CS_ORBITAL_LAB
      ReadRegStr $CSOrbitalRegisteredDir HKCU "${INSTALL_REGISTRY_KEY}" InstallLocation
    !endif
    ReadRegStr $0 HKCU "${UNINSTALL_REGISTRY_KEY}" DisplayVersion
    ${If} $0 != ""
      !insertmacro CSOrbitalTrace "registered-installation-found"
      StrCpy $0 "Instalado: $0"
    ${EndIf}
    SectionGetSize 0 $1
    OrbitalSetup::Start "$PLUGINSDIR" "${VERSION}" "$INSTDIR" "$0" "$1"
    Pop $CSOrbitalAction
    Pop $INSTDIR
    Pop $CSOrbitalDesktop
    Pop $CSOrbitalMenu
    ${If} $CSOrbitalAction == "cancel"
      !insertmacro CSOrbitalTrace "exit=1 cancelled-before-install"
      SetErrorLevel 1
      Quit
    ${ElseIf} $CSOrbitalAction != "install"
      !insertmacro CSOrbitalTrace "exit=3 frontend-start-or-wait-failed"
      MessageBox MB_OK|MB_ICONSTOP "O Orbital B terminou antes de confirmar a instalacao (codigo 3). Consulte CyberSafe-Setup-Logs na pasta temporaria."
      SetErrorLevel 3
      Quit
    ${EndIf}
    !insertmacro CSOrbitalTrace "installation-confirmed"
    ; Validate exact selected destination AFTER initMultiUser has run.
    OrbitalSetup::Validate "$INSTDIR" "$CSOrbitalRegisteredDir" "${APP_FILENAME}"
    Pop $0
    ${If} $0 != "ok"
      !insertmacro CSOrbitalTrace "exit=2 destination-refused"
      OrbitalSetup::Finish "error" "Destino recusado. Nao foram extraidos ficheiros da aplicacao."
      SetErrorLevel 2
      Quit
    ${EndIf}
    !ifndef CS_ORBITAL_LAB
      ; Do not silently convert an all-users installation or elevate because
      ; SetSilent skips the normal mode page. This path is explicitly unavailable.
      !ifdef INSTALL_MODE_PER_ALL_USERS
        !insertmacro CSOrbitalTrace "exit=2 all-users-mode-refused"
        OrbitalSetup::Finish "error" "Este percurso interativo sem elevacao nao suporta instalacao para todos os utilizadores."
        SetErrorLevel 2
        Quit
      !else
      ${If} $hasPerMachineInstallation == "1"
        !insertmacro CSOrbitalTrace "exit=2 machine-installation-refused"
        OrbitalSetup::Finish "error" "Instalacao para todos os utilizadores detetada. Este percurso sem elevacao esta indisponivel."
        SetErrorLevel 2
        Quit
      ${EndIf}
      StrCpy $installMode CurrentUser
      SetShellVarContext current
      !endif
      ; Do not call setInstallModePerUser here: it overwrites the chosen path.
    !endif
    StrCpy $CSOrbitalSavedDir "$INSTDIR"
    OrbitalSetup::Begin
    Pop $0
    ${If} $0 != "ok"
      !insertmacro CSOrbitalTrace "exit=1 frontend-closed-before-mutation"
      SetErrorLevel 1
      Quit
    ${EndIf}
    !insertmacro CSOrbitalTrace "nsis-critical-phase-started"
    SetSilent silent
    ; The normal NSIS pages are never the interactive installation frontend.
  ${EndIf}
!macroend

!macro customInstall
  ${If} $CSOrbitalActive == 1
    OrbitalSetup::Phase "NSIS: extracao terminada; a verificar o resultado e os atalhos."
    ${If} $INSTDIR != $CSOrbitalSavedDir
      !insertmacro CSOrbitalTrace "exit=2 destination-changed-after-confirmation"
      SetErrorLevel 2
      Abort "O destino divergiu da escolha validada."
    ${EndIf}
    !ifdef CS_ORBITAL_LAB
      OrbitalSetup::Verify "$INSTDIR" "${CS_ORBITAL_LAB_PAYLOAD}"
    !else
      !ifdef ZIP_COMPRESSION
        ; No trustworthy reference directory after stock ZIP extraction.
        SetErrorLevel 2
        Abort "Verificacao Orbital requer o payload 7z padrao."
      !else
        !ifdef APP_BUILD_DIR
          SetErrorLevel 2
          Abort "Verificacao Orbital requer o payload 7z padrao."
        !else
          OrbitalSetup::Verify "$INSTDIR" "$PLUGINSDIR\7z-out"
        !endif
      !endif
    !endif
    Pop $0
    ${If} $0 != "ok"
      !insertmacro CSOrbitalTrace "exit=2 installed-payload-mismatch"
      SetErrorLevel 2
      Abort "A integridade SHA-256 do payload instalado nao corresponde ao payload extraido."
    ${EndIf}
    !ifdef CS_ORBITAL_LAB
      ; Benign runtime harness verifies hashes independently after exit.
      ${IfNot} ${FileExists} "$INSTDIR\benign-19.txt"
        SetErrorLevel 2
        Abort "LAB: payload incompleto."
      ${EndIf}
    !else
      ${IfNot} ${FileExists} "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
      ${OrIfNot} ${FileExists} "$INSTDIR\resources\app.asar"
      ${OrIfNot} ${FileExists} "$INSTDIR\${UNINSTALL_FILENAME}"
        SetErrorLevel 2
        Abort "Resultado da instalacao incompleto."
      ${EndIf}
      ReadRegStr $0 SHELL_CONTEXT "${UNINSTALL_REGISTRY_KEY}" DisplayVersion
      ${If} $0 != "${VERSION}"
        !insertmacro CSOrbitalTrace "exit=2 installed-version-mismatch"
        SetErrorLevel 2
        Abort "A versao registada nao corresponde ao Setup."
      ${EndIf}
      ClearErrors
      ; Stock keepShortcuts can intentionally avoid recreating deleted links.
      ; Interactive choices must override that policy, not just delete links.
      ${If} $CSOrbitalDesktop == "0"
        ${If} ${FileExists} "$newDesktopLink"
          Delete "$newDesktopLink"
        ${EndIf}
      ${Else}
        CreateShortCut "$newDesktopLink" "$appExe" "" "$appExe" 0
      ${EndIf}
      ${If} $CSOrbitalMenu == "0"
        ${If} ${FileExists} "$newStartMenuLink"
          Delete "$newStartMenuLink"
        ${EndIf}
      ${Else}
        !ifdef MENU_FILENAME
          CreateDirectory "$SMPROGRAMS\${MENU_FILENAME}"
        !endif
        CreateShortCut "$newStartMenuLink" "$appExe" "" "$appExe" 0
      ${EndIf}
      ${If} ${Errors}
        SetErrorLevel 2
        Abort "Nao foi possivel aplicar as opcoes de atalhos."
      ${EndIf}
    !endif
    !ifndef CS_ORBITAL_LAB
      StrCpy $CSOrbitalExecutable "$appExe"
    !endif
    StrCpy $CSOrbitalVerified 1
  ${EndIf}
!macroend

; electron-builder can register stock plugins after including this file.
; Its installer template expands customHeader after the generated header.
!macro customHeader
Function .onInstSuccess
  ${If} $CSOrbitalActive == 1
    ${If} $CSOrbitalVerified == 1
      !insertmacro CSOrbitalTrace "installed-payload-verified"
      !ifdef CS_ORBITAL_LAB
      OrbitalSetup::Finish "success" "O NSIS terminou e o resultado foi verificado no destino escolhido."
      !else
        OrbitalSetup::Finish "success-open" "O NSIS terminou e o resultado foi verificado no destino escolhido."
        Pop $0
        ${If} $0 == "open"
          ; Deny writes and deletion of the open image through shell dispatch.
          ; This does not lock the entire directory or prove process startup.
          System::Call 'kernel32::CreateFileW(w "$CSOrbitalExecutable", i 0x80000000, i 1, p 0, i 3, i 0x00200000, p 0) p.r1'
          ${If} $1 == -1
            !insertmacro CSOrbitalTrace "exit=2 launch-image-open-failed"
            SetErrorLevel 2
          ${Else}
            OrbitalSetup::Verify "$CSOrbitalSavedDir" "$PLUGINSDIR\7z-out"
            Pop $0
            ${If} $0 == "ok"
              System::Call 'kernel32::GetBinaryTypeW(w "$CSOrbitalExecutable", *i .r2)i.r0'
              ${If} $0 == 0
                !insertmacro CSOrbitalTrace "exit=2 launch-image-invalid"
                SetErrorLevel 2
              ${ElseIf} $2 == 0
              ${OrIf} $2 == 6
                ${StdUtils.ExecShellAsUser} $0 "$CSOrbitalExecutable" "open" ""
                ${If} $0 != "ok"
                ${AndIf} $0 != "fallback"
                  !insertmacro CSOrbitalTrace "exit=2 launch-dispatch-failed"
                  SetErrorLevel 2
                ${Else}
                  !insertmacro CSOrbitalTrace "launch-dispatched"
                ${EndIf}
              ${Else}
                !insertmacro CSOrbitalTrace "exit=2 launch-image-unsupported"
                SetErrorLevel 2
              ${EndIf}
            ${Else}
              !insertmacro CSOrbitalTrace "exit=2 launch-payload-mismatch"
              SetErrorLevel 2
            ${EndIf}
            System::Call 'kernel32::CloseHandle(p r1)'
          ${EndIf}
        ${EndIf}
      !endif
    ${Else}
      !insertmacro CSOrbitalTrace "exit=2 success-without-verification"
      SetErrorLevel 2
      OrbitalSetup::Finish "error" "O motor terminou sem prova de instalacao completa. O resultado nao foi aprovado."
    ${EndIf}
  ${EndIf}
FunctionEnd
!macroend

Function .onInstFailed
  ${If} $CSOrbitalActive == 1
    !insertmacro CSOrbitalTrace "exit=2 nsis-failed"
    SetErrorLevel 2
    OrbitalSetup::Finish "error" "O NSIS reportou uma falha. Podem existir ficheiros parciais no destino; nao se declara sucesso nem rollback."
  ${EndIf}
FunctionEnd
!endif
