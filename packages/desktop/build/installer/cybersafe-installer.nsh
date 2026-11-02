; ---------------------------------------------------------------------------
; CyberSafe Assistant — superficie do instalador para electron-builder 25.1.8
;
; Nao substitui o script do electron-builder. Usa apenas os hooks oficiais:
;   customHeader             -> LangStrings (depois de MUI_LANGUAGE)
;   customWelcomePage        -> ecra 1: Instalar / Reparar / Desinstalar
;   customPageAfterChangeDir -> ecra 2: pasta, atalho, espaco, validacao
;   customInstall            -> respeita o atalho opcional do ecra 2
;
; O ecra 3 (progresso) e o ecra 4 (concluir) sao as paginas MUI nativas,
; alimentadas pela extraccao 7z real (Nsis7z). Nao ha progresso simulado.
; O desinstalador continua a ser o do electron-builder (dados preservados:
; deleteAppDataOnUninstall=false e o fluxo /KEEP_APP_DATA do proprio builder).
; ---------------------------------------------------------------------------

!ifndef BUILD_UNINSTALLER

!include "LogicLib.nsh"
!include "FileFunc.nsh"
!include "nsDialogs.nsh"

!define CS_ASSET_DIR "${BUILD_RESOURCES_DIR}\installer"
!include "${CS_ASSET_DIR}\cybersafe-lang.nsh"

; Texto do ecra final (a LangString e resolvida no fim da compilacao).
!define MUI_FINISHPAGE_TITLE "$(CS_FinishTitle)"
!define MUI_FINISHPAGE_TEXT "$(CS_FinishBody)"
!define MUI_FINISHPAGE_RUN_TEXT "$(CS_FinishRun)"

; UNINSTALL_REGISTRY_KEY so existe depois de multiUser.nsh, que e incluido
; depois deste ficheiro; por isso e usado apenas dentro de CS_Deferred.

Var CSDialog
Var CSW
Var CSH
Var CSBg
Var CSBgImage
Var CSFontTitle
Var CSFontHeading
Var CSMode
Var CSDesktopShortcut
Var CSStartMenuShortcut
Var CSStartMenu
Var CSInstalledVersion
Var CSInstalledDir
Var CSDirEdit
Var CSDesktop
Var CSSpaceReqLabel
Var CSSpaceFreeLabel
Var CSErrorLabel
Var CSRepairNote
Var CSErrorText
Var CSSpaceState

; --- registo das paginas (corpo expandido depois de MUI2 estar carregado) ---

!macro customWelcomePage
  !insertmacro MUI_PAGE_INIT
  !insertmacro MUI_SET CS_WELCOME_PAGE ""
  PageEx custom
    PageCallbacks CSWelcomePre CSWelcomeLeave
  PageExEnd
!macroend

!macro customPageAfterChangeDir
  !insertmacro MUI_PAGE_INIT
  !insertmacro MUI_SET CS_CONFIG_PAGE ""
  PageEx custom
    PageCallbacks CSConfigPre CSConfigLeave
  PageExEnd
!macroend

; --- codigo diferido: so compila depois de MUI2, MUI_LANGUAGE e flags ---

!macro customHeader
  !insertmacro CS_LangStrings
  !insertmacro CS_Deferred
!macroend

!macro CS_BeginPage BMPNAME
  nsDialogs::Create 1018
  Pop $CSDialog
  ${If} $CSDialog == error
    Abort
  ${EndIf}
  InitPluginsDir
  SetOutPath "$PLUGINSDIR"
  File "/oname=${BMPNAME}" "${CS_ASSET_DIR}\${BMPNAME}"
  ${NSD_CreateBitmap} 0 0 1u 1u ""
  Pop $CSBg
  Call CS_Measure
  System::Call 'user32::MoveWindow(p $CSBg, i 0, i 0, i $CSW, i $CSH, i 1)'
  ${NSD_SetStretchedImage} $CSBg "$PLUGINSDIR\${BMPNAME}" $CSBgImage
  ; SetStretchedImage deixa o bitmap no topo; empurra-o para tras dos controlos.
  System::Call 'user32::SetWindowPos(p $CSBg, p 1, i 0, i 0, i 0, i 0, i 0x13)'
!macroend

; Posiciona em percentagem da area util, para alinhar com o bitmap esticado
; em qualquer tamanho de janela/DPI.
!macro CS_Place CONTROL XPCT YPCT WPCT HPCT
  IntOp $R0 $CSW * ${XPCT}
  IntOp $R0 $R0 / 100
  IntOp $R1 $CSH * ${YPCT}
  IntOp $R1 $R1 / 100
  IntOp $R2 $CSW * ${WPCT}
  IntOp $R2 $R2 / 100
  IntOp $R3 $CSH * ${HPCT}
  IntOp $R3 $R3 / 100
  System::Call 'user32::MoveWindow(p ${CONTROL}, i $R0, i $R1, i $R2, i $R3, i 1)'
  ; O bitmap de fundo e criado como controlo irmao; sem este raise os
  ; labels/botoes ficam por tras dele em algumas versoes do nsDialogs.
  System::Call 'user32::SetWindowPos(p ${CONTROL}, p 0, i 0, i 0, i 0, i 0, i 0x13)'
!macroend

!macro CS_CardColors CONTROL
  SetCtlColors ${CONTROL} 0x20130C 0xFAF6F3
!macroend

; ReadRegStr exige uma chave de registo literal, por isso o root vem por
; parametro do macro e nao de uma variavel.
!macro CS_ReadRoot ROOT
  ReadRegStr $0 ${ROOT} "${UNINSTALL_REGISTRY_KEY}" InstallLocation
  ReadRegStr $1 ${ROOT} "${UNINSTALL_REGISTRY_KEY}" DisplayVersion
  ${If} $0 == ""
  ${AndIf} $1 != ""
    ; Ha instalacoes antigas com InstallLocation vazio. O caminho e fixo
    ; (allowToChangeInstallationDirectory=false); so o aceitamos se o
    ; desinstalador real existir, nunca por suposicao.
    StrCpy $0 "$LOCALAPPDATA\Programs\${APP_FILENAME}"
    ${IfNot} ${FileExists} "$0\Uninstall ${PRODUCT_FILENAME}.exe"
      StrCpy $0 ""
    ${EndIf}
  ${EndIf}
  ${If} $0 != ""
  ${AndIf} ${FileExists} "$0\Uninstall ${PRODUCT_FILENAME}.exe"
    StrCpy $CSInstalledDir "$0"
    StrCpy $CSInstalledVersion "$1"
  ${EndIf}
  !ifdef UNINSTALL_REGISTRY_KEY_2
    ReadRegStr $0 ${ROOT} "${UNINSTALL_REGISTRY_KEY_2}" InstallLocation
    ReadRegStr $1 ${ROOT} "${UNINSTALL_REGISTRY_KEY_2}" DisplayVersion
    ${If} $0 != ""
    ${AndIf} ${FileExists} "$0\Uninstall ${PRODUCT_FILENAME}.exe"
      StrCpy $CSInstalledDir "$0"
      StrCpy $CSInstalledVersion "$1"
    ${EndIf}
  !endif
!macroend

; O atalho stock ja foi criado pela seccao de instalacao; se o utilizador o
; desmarcou no ecra 2, remove-se aqui (e notifica o Explorer).
!macro customInstall
  ${If} $CSDesktopShortcut == "0"
    ${If} ${FileExists} "$newDesktopLink"
      Delete "$newDesktopLink"
      System::Call 'Shell32::SHChangeNotify(i 0x8000000, i 0, i 0, i 0)'
    ${EndIf}
  ${EndIf}
  ${If} $CSStartMenuShortcut == "0"
    ${If} ${FileExists} "$newStartMenuLink"
      Delete "$newStartMenuLink"
      System::Call 'Shell32::SHChangeNotify(i 0x8000000, i 0, i 0, i 0)'
    ${EndIf}
    ; Apenas remove a pasta do produto se estiver vazia.
    !ifdef MENU_FILENAME
      RMDir "$SMPROGRAMS\${MENU_FILENAME}"
    !endif
  ${EndIf}
!macroend

; Busca de subcadeia propria: o StrContains.nsh do electron-builder declara
; Vars sem guarda e colide quando allowToChangeInstallationDirectory tambem o
; inclui. StrCmp do NSIS e case-insensitive, que e o adequado para caminhos.
; Entrada: $R0 = agulha, $R1 = palheiro. Saida: $R2 = 1 contido / 0 nao contido.
!macro CS_ContainsBody
  Push $0
  Push $1
  Push $2
  Push $3
  StrCpy $2 0
  StrLen $3 "$R0"
  StrCmp $3 0 0 +3
    StrCpy $2 1
    Goto cs_done
  StrCpy $0 0
  cs_loop:
    StrCpy $1 "$R1" $3 $0
    StrCmp $1 "" cs_done
    StrCmp $1 "$R0" cs_found
    IntOp $0 $0 + 1
    Goto cs_loop
  cs_found:
    StrCpy $2 1
  cs_done:
    ; $R2 e a saida documentada: sem esta copia o chamador lia o valor
    ; anterior de $R2 e o Pop abaixo devolvia $2 ao valor de entrada.
    StrCpy $R2 $2
    Pop $3
    Pop $2
    Pop $1
    Pop $0
!macroend

; Aborta a validacao com a mensagem de caminho invalido se a agulha existir.
!macro CS_InvalidIf NEEDLE
  StrCpy $R0 "${NEEDLE}"
  StrCpy $R1 "$INSTDIR"
  Call CS_Contains
  ${If} $R2 == 1
    StrCpy $CSErrorText "$(CS_InvalidPath)"
    Return
  ${EndIf}
!macroend

!macro CS_Deferred

  ; Mede a area util da pagina (pixels logicos; NSIS e DPI-unaware).
  Function CS_Measure
    System::Alloc 16
    Pop $R9
    System::Call 'user32::GetClientRect(p $CSDialog, p $R9)'
    System::Call '*$R9(i .r0, i .r1, i .r2, i .r3)'
    System::Free $R9
    StrCpy $CSW $2
    StrCpy $CSH $3
  FunctionEnd

  ; Cria os dois pesos tipograficos usados nos titulos. Se a fonte nao
  ; existir, CreateFont devolve uma fonte de sistema e o texto continua legivel.
  Function CS_CreateFonts
    System::Call 'gdi32::CreateFont(i -18, i 0, i 0, i 0, i 600, i 0, i 0, i 0, i 1, i 0, i 0, i 5, i 0, w "Segoe UI Semibold") p.r0'
    StrCpy $CSFontTitle $R0
    System::Call 'gdi32::CreateFont(i -14, i 0, i 0, i 0, i 600, i 0, i 0, i 0, i 1, i 0, i 0, i 5, i 0, w "Segoe UI Semibold") p.r0'
    StrCpy $CSFontHeading $R0
  FunctionEnd

  Function CS_Contains
    !insertmacro CS_ContainsBody
  FunctionEnd

  Function CS_FreeResources
    ${If} $CSFontTitle != ""
      System::Call 'gdi32::DeleteObject(p $CSFontTitle)'
      StrCpy $CSFontTitle ""
    ${EndIf}
    ${If} $CSFontHeading != ""
      System::Call 'gdi32::DeleteObject(p $CSFontHeading)'
      StrCpy $CSFontHeading ""
    ${EndIf}
    ${If} $CSBgImage != ""
      ${NSD_FreeImage} $CSBgImage
      StrCpy $CSBgImage ""
    ${EndIf}
  FunctionEnd

  ; --- deteccao real da instalacao existente (HKCU e HKLM) ---

  Function CS_ReadHKCU
    !insertmacro CS_ReadRoot HKCU
  FunctionEnd

  Function CS_ReadHKLM
    !insertmacro CS_ReadRoot HKLM
  FunctionEnd

  Function CS_Detect
    StrCpy $CSInstalledDir ""
    StrCpy $CSInstalledVersion ""
    Call CS_ReadHKCU
    ${If} $CSInstalledDir == ""
      Call CS_ReadHKLM
    ${EndIf}
  FunctionEnd

  ; --- ecra 1 ---

  Function CS_ChooseInstall
    StrCpy $CSMode "install"
    GetDlgItem $0 $HWNDPARENT 1
    SendMessage $0 ${BM_CLICK} 0 0
  FunctionEnd

  Function CS_ChooseRepair
    StrCpy $CSMode "repair"
    GetDlgItem $0 $HWNDPARENT 1
    SendMessage $0 ${BM_CLICK} 0 0
  FunctionEnd

  Function CS_ShowLicense
    ${If} ${FileExists} "$PLUGINSDIR\THIRD-PARTY-NOTICES.txt"
      ExecShell "open" "$PLUGINSDIR\THIRD-PARTY-NOTICES.txt"
    ${Else}
      MessageBox MB_ICONEXCLAMATION|MB_OK "As licencas de terceiros nao estao disponiveis neste instalador."
    ${EndIf}
  FunctionEnd

  Function CS_ChooseUninstall
    ${If} $CSInstalledDir == ""
      Return
    ${EndIf}
    ; Desinstalador real do electron-builder. Nao apaga dados de utilizador
    ; (deleteAppDataOnUninstall=false); o utilizador ve a UI do desinstalador.
    ExecShell "open" "$CSInstalledDir\Uninstall ${PRODUCT_FILENAME}.exe"
    Quit
  FunctionEnd

  Function CSWelcomePre
    ${If} ${Silent}
      Abort
    ${EndIf}

    StrCpy $CSMode "install"
    StrCpy $CSDesktopShortcut "1"
    StrCpy $CSStartMenuShortcut "1"
    Call CS_Detect

    !insertmacro MUI_HEADER_TEXT "$(CS_WelcomeHeader)" ""
    !insertmacro CS_BeginPage "page-welcome.bmp"
    ; Mostra o documento real de licencas, incluido no instalador. Nao ha texto
    ; de licenca inventado nem um link remoto.
    File "/oname=THIRD-PARTY-NOTICES.txt" "${PROJECT_DIR}\assets\licenses\THIRD-PARTY-NOTICES.txt"
    Call CS_CreateFonts

    ${NSD_CreateLabel} 0 0 1u 1u "$(CS_WelcomeTitle)"
    Pop $R9
    !insertmacro CS_Place $R9 39 8 57 9
    !insertmacro CS_CardColors $R9
    ${If} $CSFontTitle != ""
      SendMessage $R9 ${WM_SETFONT} $CSFontTitle 1
    ${EndIf}

    ${NSD_CreateLabel} 0 0 1u 1u "$(CS_WelcomeVersionPrefix) ${VERSION}"
    Pop $R9
    !insertmacro CS_Place $R9 39 19 57 5
    !insertmacro CS_CardColors $R9

    ${If} $CSInstalledDir != ""
      ${NSD_CreateLabel} 0 0 1u 1u "$(CS_InstalledPrefix): $CSInstalledVersion"
      Pop $R9
      !insertmacro CS_Place $R9 39 25 57 5
      !insertmacro CS_CardColors $R9
    ${Else}
      ${NSD_CreateLabel} 0 0 1u 1u "$(CS_NotInstalled)"
      Pop $R9
      !insertmacro CS_Place $R9 39 25 57 8
      !insertmacro CS_CardColors $R9
    ${EndIf}

    ${NSD_CreateLabel} 0 0 1u 1u "$(CS_WelcomeBody)"
    Pop $R9
    !insertmacro CS_Place $R9 39 36 55 24
    !insertmacro CS_CardColors $R9

    ${NSD_CreateButton} 0 0 1u 1u "$(CS_InstallBtn)"
    Pop $R9
    !insertmacro CS_Place $R9 39 64 24 8
    ${NSD_OnClick} $R9 CS_ChooseInstall

    ${NSD_CreateButton} 0 0 1u 1u "$(CS_RepairBtn)"
    Pop $R9
    !insertmacro CS_Place $R9 64 64 24 8
    ${NSD_OnClick} $R9 CS_ChooseRepair
    ${If} $CSInstalledDir == ""
      EnableWindow $R9 0
    ${EndIf}

    ${NSD_CreateButton} 0 0 1u 1u "$(CS_UninstallBtn)"
    Pop $R9
    !insertmacro CS_Place $R9 39 75 24 8
    ${NSD_OnClick} $R9 CS_ChooseUninstall
    ${If} $CSInstalledDir == ""
      EnableWindow $R9 0
    ${EndIf}

    ${NSD_CreateButton} 0 0 1u 1u "$(CS_LicenseBtn)"
    Pop $R9
    !insertmacro CS_Place $R9 64 75 24 8
    ${NSD_OnClick} $R9 CS_ShowLicense

    ; A pagina tem os seus proprios botoes de accao; o Next/Back do wizard
    ; ficam ocultos apenas aqui e sao repostos ao sair.
    GetDlgItem $0 $HWNDPARENT 1
    ShowWindow $0 ${SW_HIDE}
    GetDlgItem $0 $HWNDPARENT 2
    ShowWindow $0 ${SW_HIDE}

    nsDialogs::Show
  FunctionEnd

  Function CSWelcomeLeave
    GetDlgItem $0 $HWNDPARENT 1
    ShowWindow $0 ${SW_SHOW}
    GetDlgItem $0 $HWNDPARENT 2
    ShowWindow $0 ${SW_SHOW}
    Call CS_FreeResources
  FunctionEnd

  ; --- ecra 2 ---

  ; Devolve mensagem em $CSErrorText ("" quando valido) e normaliza $INSTDIR.
  Function CS_ValidatePath
    StrCpy $CSErrorText ""

    StrCpy $R0 "$INSTDIR" 1 -1
    ${If} $R0 == "\"
      StrCpy $INSTDIR "$INSTDIR" -1
    ${EndIf}

    StrLen $R0 "$INSTDIR"
    ${If} $R0 < 4
      StrCpy $CSErrorText "$(CS_InvalidPath)"
      Return
    ${EndIf}

    StrCpy $R0 "$INSTDIR" 1 1
    ${If} $R0 != ":"
      StrCpy $CSErrorText "$(CS_InvalidPath)"
      Return
    ${EndIf}

    !insertmacro CS_InvalidIf "<"
    !insertmacro CS_InvalidIf ">"
    !insertmacro CS_InvalidIf "|"
    !insertmacro CS_InvalidIf "?"
    !insertmacro CS_InvalidIf "*"

    ; Mesma regra do instalador stock: a pasta do produto e acrescentada
    ; quando o caminho escolhido ainda nao a contem.
    StrCpy $R0 "${APP_FILENAME}"
    StrCpy $R1 "$INSTDIR"
    Call CS_Contains
    ${If} $R2 == 0
      StrCpy $INSTDIR "$INSTDIR\${APP_FILENAME}"
    ${EndIf}

    ; Prova de escrita real, sem tocar em nada preexistente: o nome e unico e o
    ; diretorio e criado de forma exclusiva (CreateDirectory falha se existir).
    ; So se remove o que esta tentativa criou; um ficheiro/pasta anterior com
    ; nome parecido nunca e truncado nem apagado.
    ClearErrors
    CreateDirectory "$INSTDIR"
    ${If} ${Errors}
      StrCpy $CSErrorText "$(CS_NoWrite)"
      Return
    ${EndIf}
    StrCpy $0 0
    cs_probe_try:
      System::Call 'kernel32::GetTickCount() i .r1'
      IntOp $1 $1 + $0
      StrCpy $2 "$INSTDIR\.cs-probe-$1"
      ; A instrucao NSIS CreateDirectory aceita ERROR_ALREADY_EXISTS quando o
      ; alvo e um diretorio (EW_CREATEDIR), logo nao serve como aquisicao
      ; exclusiva. Chama-se a API diretamente e exige-se BOOL != 0: so depois
      ; de a criacao ser nossa e que se escreve ou apaga algo.
      ClearErrors
      StrCpy $3 0
      System::Call 'kernel32::CreateDirectoryW(w "$2", p 0) i .r3'
      ${If} $3 = 0
        ; Criacao falhou. Se o nome passou a existir, e colisao com algo
        ; alheio: tenta outro nome e nunca toca nesse caminho. Se nao existe,
        ; e falha real de escrita/permissao.
        StrCpy $4 -1
        System::Call 'kernel32::GetFileAttributesW(w "$2") i .r4'
        ${If} $4 != -1
          IntOp $0 $0 + 1
          ${If} $0 > 7
            StrCpy $CSErrorText "$(CS_NoWrite)"
            Return
          ${EndIf}
          Goto cs_probe_try
        ${EndIf}
        StrCpy $CSErrorText "$(CS_NoWrite)"
        Return
      ${EndIf}
      ClearErrors
      FileOpen $R1 "$2\probe" w
      ${If} ${Errors}
        RMDir "$2"
        StrCpy $CSErrorText "$(CS_NoWrite)"
        Return
      ${EndIf}
      FileClose $R1
      Delete "$2\probe"
      RMDir "$2"

    ; Espaco: necessario = KB da seccao 0 arredondado para cima a MB (conservador);
    ; livre = MB que o sistema reporta (truncado, logo tambem conservador).
    ; Zero livre com algo a instalar e insuficiente. Quando a leitura falha, o
    ; estado fica "unknown": nao se afirma nem sucesso nem falha de espaco.
    SectionGetSize 0 $R0
    ${If} $R0 > 0
      IntOp $R1 $R0 + 1023
      IntOp $R1 $R1 / 1024
    ${Else}
      StrCpy $R1 0
    ${EndIf}
    ${DriveSpace} "$INSTDIR" "/D=F /S=M" $R2
    ${If} $R2 == ""
      StrCpy $CSSpaceState "unknown"
    ${Else}
      StrCpy $CSSpaceState "measured"
      ${If} $R1 > 0
      ${AndIf} $R2 < $R1
        StrCpy $CSErrorText "$(CS_NoSpace)"
      ${EndIf}
    ${EndIf}
  FunctionEnd

  Function CS_UpdateSpace
    ${If} $INSTDIR == ""
      StrCpy $INSTDIR "$LOCALAPPDATA\Programs\${APP_FILENAME}"
    ${EndIf}
    SectionGetSize 0 $R0
    ${If} $R0 > 0
      IntOp $R0 $R0 + 1023
      IntOp $R0 $R0 / 1024
    ${EndIf}
    ${DriveSpace} "$INSTDIR" "/D=F /S=M" $R1
    ${If} $R1 == ""
      StrCpy $R1 "?"
      StrCpy $CSSpaceState "unknown"
    ${Else}
      StrCpy $CSSpaceState "measured"
    ${EndIf}
    StrCpy $R2 "$(CS_SpaceRequired) $R0 $(CS_UnitMB)"
    ${NSD_SetText} $CSSpaceReqLabel "$R2"
    StrCpy $R2 "$(CS_SpaceAvailable) $R1 $(CS_UnitMB)"
    ${NSD_SetText} $CSSpaceFreeLabel "$R2"
  FunctionEnd

  Function CS_Browse
    ${NSD_GetText} $CSDirEdit $R0
    ${If} $R0 == ""
      StrCpy $R0 "$INSTDIR"
    ${EndIf}
    nsDialogs::SelectFolderDialog "$(CS_FolderLabel)" "$R0"
    Pop $R1
    ${If} $R1 != error
    ${AndIf} $R1 != ""
      ${NSD_SetText} $CSDirEdit "$R1"
      StrCpy $INSTDIR "$R1"
      Call CS_UpdateSpace
    ${EndIf}
  FunctionEnd

  Function CSConfigPre
    ${If} ${Silent}
      Abort
    ${EndIf}
    ${If} ${isUpdated}
      Abort
    ${EndIf}

    ${If} $CSMode == "repair"
    ${AndIf} $CSInstalledDir != ""
      StrCpy $INSTDIR "$CSInstalledDir"
    ${EndIf}
    ${If} $INSTDIR == ""
      StrCpy $INSTDIR "$LOCALAPPDATA\Programs\${APP_FILENAME}"
    ${EndIf}

    !insertmacro MUI_HEADER_TEXT "$(CS_ConfigHeader)" ""
    !insertmacro CS_BeginPage "page-config.bmp"
    Call CS_CreateFonts

    ${NSD_CreateLabel} 0 0 1u 1u "$(CS_ConfigTitle)"
    Pop $R9
    !insertmacro CS_Place $R9 39 8 57 7
    !insertmacro CS_CardColors $R9
    ${If} $CSFontHeading != ""
      SendMessage $R9 ${WM_SETFONT} $CSFontHeading 1
    ${EndIf}

    ${NSD_CreateLabel} 0 0 1u 1u "$(CS_FolderLabel)"
    Pop $R9
    !insertmacro CS_Place $R9 39 22 57 5
    !insertmacro CS_CardColors $R9

    ${NSD_CreateText} 0 0 1u 1u "$INSTDIR"
    Pop $CSDirEdit
    !insertmacro CS_Place $CSDirEdit 39 29 43 7

    ${NSD_CreateButton} 0 0 1u 1u "$(CS_Browse)"
    Pop $R9
    !insertmacro CS_Place $R9 83 29 13 7
    ${NSD_OnClick} $R9 CS_Browse

    ${NSD_CreateCheckbox} 0 0 1u 1u "$(CS_DesktopShortcut)"
    Pop $CSDesktop
    !insertmacro CS_Place $CSDesktop 39 40 57 6
    ${NSD_SetState} $CSDesktop ${BST_CHECKED}

    ${NSD_CreateCheckbox} 0 0 1u 1u "$(CS_StartMenuShortcut)"
    Pop $CSStartMenu
    !insertmacro CS_Place $CSStartMenu 39 46 57 5
    ${NSD_SetState} $CSStartMenu ${BST_CHECKED}

    ${NSD_CreateLabel} 0 0 1u 1u ""
    Pop $CSRepairNote
    !insertmacro CS_Place $CSRepairNote 39 53 57 7
    !insertmacro CS_CardColors $CSRepairNote
    ${If} $CSMode == "repair"
      ${NSD_SetText} $CSRepairNote "$(CS_RepairModeNote)"
    ${EndIf}

    ${NSD_CreateLabel} 0 0 1u 1u ""
    Pop $CSSpaceReqLabel
    !insertmacro CS_Place $CSSpaceReqLabel 39 63 57 5
    !insertmacro CS_CardColors $CSSpaceReqLabel

    ${NSD_CreateLabel} 0 0 1u 1u ""
    Pop $CSSpaceFreeLabel
    !insertmacro CS_Place $CSSpaceFreeLabel 39 70 57 5
    !insertmacro CS_CardColors $CSSpaceFreeLabel

    ${NSD_CreateLabel} 0 0 1u 1u ""
    Pop $CSErrorLabel
    !insertmacro CS_Place $CSErrorLabel 39 79 57 9
    SetCtlColors $CSErrorLabel 0x2000B0 0xFAF6F3

    ; O botao Next passa a chamar-se Instalar apenas neste ecra.
    GetDlgItem $0 $HWNDPARENT 1
    ShowWindow $0 ${SW_SHOW}
    SendMessage $0 ${WM_SETTEXT} 0 "STR:$(CS_InstallBtn)"
    GetDlgItem $0 $HWNDPARENT 2
    ShowWindow $0 ${SW_SHOW}

    Call CS_UpdateSpace
    nsDialogs::Show
  FunctionEnd

  Function CSConfigLeave
    ${NSD_GetText} $CSDirEdit "$INSTDIR"
    Call CS_ValidatePath
    ${If} $CSErrorText != ""
      ${NSD_SetText} $CSErrorLabel "$CSErrorText"
      Abort
    ${EndIf}

    ${NSD_GetState} $CSDesktop $R0
    ${If} $R0 == ${BST_CHECKED}
      StrCpy $CSDesktopShortcut "1"
    ${Else}
      StrCpy $CSDesktopShortcut "0"
    ${EndIf}

    ${NSD_GetState} $CSStartMenu $R0
    ${If} $R0 == ${BST_CHECKED}
      StrCpy $CSStartMenuShortcut "1"
    ${Else}
      StrCpy $CSStartMenuShortcut "0"
    ${EndIf}

    Call CS_FreeResources
  FunctionEnd

!macroend

!endif
