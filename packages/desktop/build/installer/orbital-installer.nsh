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

!macro customInit
  StrCpy $CSOrbitalActive 0
  StrCpy $CSOrbitalVerified 0
  ; /S is owned by the verified launcher/updater: no UI, no option overrides.
  ${IfNot} ${Silent}
    StrCpy $CSOrbitalActive 1
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
      StrCpy $0 "Instalado: $0"
    ${EndIf}
    SectionGetSize 0 $1
    OrbitalSetup::Start "$PLUGINSDIR" "${VERSION}" "$INSTDIR" "$0" "$1"
    Pop $CSOrbitalAction
    Pop $INSTDIR
    Pop $CSOrbitalDesktop
    Pop $CSOrbitalMenu
    ${If} $CSOrbitalAction != "install"
      SetErrorLevel 1
      Quit
    ${EndIf}
    ; Validate exact selected destination AFTER initMultiUser has run.
    OrbitalSetup::Validate "$INSTDIR" "$CSOrbitalRegisteredDir" "${APP_FILENAME}"
    Pop $0
    ${If} $0 != "ok"
      OrbitalSetup::Finish "error" "Destino recusado. Nao foram extraidos ficheiros da aplicacao."
      SetErrorLevel 2
      Quit
    ${EndIf}
    !ifndef CS_ORBITAL_LAB
      ; Do not silently convert an all-users installation or elevate because
      ; SetSilent skips the normal mode page. This path is explicitly unavailable.
      !ifdef INSTALL_MODE_PER_ALL_USERS
        OrbitalSetup::Finish "error" "Este percurso interativo sem elevacao nao suporta instalacao para todos os utilizadores."
        SetErrorLevel 2
        Quit
      !else
      ${If} $hasPerMachineInstallation == "1"
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
      SetErrorLevel 1
      Quit
    ${EndIf}
    SetSilent silent
    ; The normal NSIS pages are never the interactive installation frontend.
  ${EndIf}
!macroend

!macro customInstall
  ${If} $CSOrbitalActive == 1
    OrbitalSetup::Phase "NSIS: extracao terminada; a verificar o resultado e os atalhos."
    ${If} $INSTDIR != $CSOrbitalSavedDir
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

Function .onInstSuccess
  ${If} $CSOrbitalActive == 1
    ${If} $CSOrbitalVerified == 1
      !ifdef CS_ORBITAL_LAB
      OrbitalSetup::Finish "success" "O NSIS terminou e o resultado foi verificado no destino escolhido."
      !else
        OrbitalSetup::Finish "success-open" "O NSIS terminou e o resultado foi verificado no destino escolhido."
        Pop $0
        ${If} $0 == "open"
          ${If} ${FileExists} "$CSOrbitalExecutable"
            ${StdUtils.ExecShellAsUser} $0 "$CSOrbitalExecutable" "open" ""
          ${EndIf}
        ${EndIf}
      !endif
    ${Else}
      SetErrorLevel 2
      OrbitalSetup::Finish "error" "O motor terminou sem prova de instalacao completa. O resultado nao foi aprovado."
    ${EndIf}
  ${EndIf}
FunctionEnd

Function .onInstFailed
  ${If} $CSOrbitalActive == 1
    SetErrorLevel 2
    OrbitalSetup::Finish "error" "O NSIS reportou uma falha. Podem existir ficheiros parciais no destino; nao se declara sucesso nem rollback."
  ${EndIf}
FunctionEnd
!endif
