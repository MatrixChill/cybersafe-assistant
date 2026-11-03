; Standalone visual feasibility prototype. No installation, registry, shortcuts,
; services, extraction payload, uninstaller or production installer hooks.
Unicode true
ManifestDPIAware true
RequestExecutionLevel user
LoadLanguageFile "${NSISDIR}\Contrib\Language files\Portuguese.nlf"
Name "CyberSafe — protótipo nativo"
Caption "CyberSafe · estudo visual NSIS · não instala"
!include "nsDialogs.nsh"
!include "LogicLib.nsh"
!include "FileFunc.nsh"
!ifndef CS_PREVIEW_OUT
  !error "Supply CS_PREVIEW_OUT (output exe outside source)."
!endif
!ifndef CS_PRODUCT_VERSION
  !error "Supply CS_PRODUCT_VERSION from product-version.json."
!endif
!ifndef CS_OFFICIAL_ICON
  !error "Supply CS_OFFICIAL_ICON from existing official assets."
!endif
OutFile "${CS_PREVIEW_OUT}"
Icon "${CS_OFFICIAL_ICON}"
BrandingText "PROTÓTIPO · NÃO INSTALA"
InstallButtonText "Fechar"
ShowInstDetails nevershow
Page custom PreviewCreate
Section
  ; Deliberately empty: this executable cannot install the application.
SectionEnd
!include "${CS_PREVIEW_ASSETS}\cybersafe-controls.nsh"
Var Bg
Var BgImage
Var Dialog
Var Heading
Var Body
Var Status
Var TitleFont
Var BodyFont
Var Mode
Var WindowDpi
Var LayoutWidth
Var LayoutHeight
Var ClientWidth
Var ClientHeight
Var HeadingFont
Var Nav0
Var Nav1
Var Nav2
Var Nav3
Var Nav4

Function ClosePreview
  Quit
FunctionEnd
Function ModeInstall
  ${NSD_SetText} $Heading "Instalar o CyberSafe"
  ${NSD_SetText} $Body "Proposta: opções, atalhos e espaço antes de confirmar.$\r$\nMotor NSIS existente. Nenhuma operação executada."
  ${NSD_SetText} $Status "ESTUDO VISUAL · operação não iniciada"
FunctionEnd
Function ModeRepair
  ${NSD_SetText} $Heading "Reparar uma instalação"
  ${NSD_SetText} $Body "Proposta: versão detetada e reparação com dados preservados.$\r$\nNenhuma instalação é consultada neste protótipo."
  ${NSD_SetText} $Status "ESTUDO VISUAL · nenhuma instalação consultada"
FunctionEnd
Function ModeUpgrade
  ${NSD_SetText} $Heading "Atualizar com confiança"
  ${NSD_SetText} $Body "Proposta: versões, integridade e preservação dos dados.$\r$\nSem download nem progresso fictício neste estudo."
  ${NSD_SetText} $Status "ESTUDO VISUAL · nenhum upgrade executado"
FunctionEnd
Function ModeSelect
  StrCpy $0 $Mode
  ${If} $0 == "Instalação"
    Call ModeInstall
  ${ElseIf} $0 == "Atualização"
    Call ModeUpgrade
  ${ElseIf} $0 == "Reparação"
    Call ModeRepair
  ${ElseIf} $0 == "Progresso"
    ${NSD_SetText} $Heading "Acompanhar a operação real"
    ${NSD_SetText} $Body "O setup definitivo mostrará extração e etapas reais do NSIS.$\r$\nEste protótipo não executa tarefas nem apresenta percentagens."
    ${NSD_SetText} $Status "PROPOSTA · sem operação em curso"
  ${ElseIf} $0 == "Conclusão"
    ${NSD_SetText} $Heading "Resumo verificável da operação"
    ${NSD_SetText} $Body "A conclusão dependerá do resultado real e das verificações finais.$\r$\nNão existe instalação concluída neste protótipo."
    ${NSD_SetText} $Status "PROPOSTA · não é um resultado de instalação"
  ${ElseIf} $0 == "Erros"
    ${NSD_SetText} $Heading "Um erro com contexto e recuperação"
    ${NSD_SetText} $Body "O setup definitivo identificará a etapa e a ação de recuperação.$\r$\nNão será apresentado sucesso quando uma etapa falhar."
    ${NSD_SetText} $Status "PROPOSTA · nenhum erro de instalação foi provocado"
  ${ElseIf} $0 == "Desinstalação"
    ${NSD_SetText} $Heading "Remover com uma decisão informada"
    ${NSD_SetText} $Body "O desinstalador existente mantém o controlo da remoção.$\r$\nNeste estudo não são consultados nem removidos ficheiros."
    ${NSD_SetText} $Status "PROPOSTA · nenhuma remoção autorizada ou executada"
  ${Else}
    ${NSD_SetText} $Heading "CyberSafe Assistant para Windows"
    ${NSD_SetText} $Body "Identidade oficial, hierarquia clara e controlo em cada etapa.$\r$\nEscolhe um percurso para explorar esta proposta executável."
    ${NSD_SetText} $Status "PROTÓTIPO VISUAL · não instala nem altera o Windows"
  ${EndIf}
FunctionEnd
Function Select0
  Pop $0
  StrCpy $Mode "Boas-vindas"
  Call ModeSelect
  Call NavPaint
FunctionEnd

Function Select1
  Pop $0
  StrCpy $Mode "Instalação"
  Call ModeSelect
  Call NavPaint
FunctionEnd

Function Select2
  Pop $0
  StrCpy $Mode "Atualização"
  Call ModeSelect
  Call NavPaint
FunctionEnd

Function Select3
  Pop $0
  StrCpy $Mode "Reparação"
  Call ModeSelect
  Call NavPaint
FunctionEnd

Function Select7
  Pop $0
  StrCpy $Mode "Desinstalação"
  Call ModeSelect
  Call NavPaint
FunctionEnd

Function NavPaint
  ${If} $Mode == "Boas-vindas"
    !insertmacro CS_StyleButton $Nav0 "$PLUGINSDIR\button-primary.bmp"
  ${Else}
    !insertmacro CS_StyleButton $Nav0 "$PLUGINSDIR\button-secondary.bmp"
  ${EndIf}
  ${If} $Mode == "Instalação"
    !insertmacro CS_StyleButton $Nav1 "$PLUGINSDIR\button-primary.bmp"
  ${Else}
    !insertmacro CS_StyleButton $Nav1 "$PLUGINSDIR\button-secondary.bmp"
  ${EndIf}
  ${If} $Mode == "Atualização"
    !insertmacro CS_StyleButton $Nav2 "$PLUGINSDIR\button-primary.bmp"
  ${Else}
    !insertmacro CS_StyleButton $Nav2 "$PLUGINSDIR\button-secondary.bmp"
  ${EndIf}
  ${If} $Mode == "Reparação"
    !insertmacro CS_StyleButton $Nav3 "$PLUGINSDIR\button-primary.bmp"
  ${Else}
    !insertmacro CS_StyleButton $Nav3 "$PLUGINSDIR\button-secondary.bmp"
  ${EndIf}
  ${If} $Mode == "Desinstalação"
    !insertmacro CS_StyleButton $Nav4 "$PLUGINSDIR\button-primary.bmp"
  ${Else}
    !insertmacro CS_StyleButton $Nav4 "$PLUGINSDIR\button-secondary.bmp"
  ${EndIf}
FunctionEnd

Function PreviewCreate
  nsDialogs::Create 1018
  Pop $Dialog
  ; Resize this preview window only; no OS preference or installation changes.
  System::Call 'user32::GetDpiForWindow(p $HWNDPARENT)i.r0'
  ${If} $0 == 0
    StrCpy $0 96
  ${EndIf}
  StrCpy $WindowDpi $0
  IntOp $LayoutWidth 900 * $WindowDpi
  IntOp $LayoutWidth $LayoutWidth / 96
  IntOp $LayoutHeight 600 * $WindowDpi
  IntOp $LayoutHeight $LayoutHeight / 96
  System::Call 'user32::GetSystemMetrics(i 0)i.r0'
  IntOp $0 $0 - $LayoutWidth
  IntOp $0 $0 / 2
  System::Call 'user32::GetSystemMetrics(i 1)i.r1'
  IntOp $1 $1 - $LayoutHeight
  IntOp $1 $1 / 2
  System::Call 'user32::MoveWindow(p $HWNDPARENT,i r0,i r1,i $LayoutWidth,i $LayoutHeight,i 1)'
  ; Read all four RECT members, not a guessed frame-border height.
  System::Alloc 16
  Pop $R9
  System::Call 'user32::GetClientRect(p $HWNDPARENT,p $R9)'
  System::Call '*$R9(i,i,i .r2,i .r3)'
  StrCpy $ClientWidth $2
  StrCpy $ClientHeight $3
  System::Free $R9
  System::Call 'user32::SetWindowPos(p $Dialog,p 0,i 0,i 0,i $ClientWidth,i $ClientHeight,i 0x40)'
  GetDlgItem $0 $HWNDPARENT 1
  ShowWindow $0 0
  GetDlgItem $0 $HWNDPARENT 2
  ShowWindow $0 0
  GetDlgItem $0 $HWNDPARENT 1035
  ShowWindow $0 0
  System::Call 'dwmapi::DwmSetWindowAttribute(p $HWNDPARENT,i 20,*i 1,i 4)i.r0'
  System::Call 'dwmapi::DwmSetWindowAttribute(p $HWNDPARENT,i 35,*i 0x001A1507,i 4)i.r0'
  System::Call 'dwmapi::DwmSetWindowAttribute(p $HWNDPARENT,i 36,*i 0x00F8F8ED,i 4)i.r0'
  System::Call 'dwmapi::DwmSetWindowAttribute(p $HWNDPARENT,i 34,*i 0x001A1507,i 4)i.r0'
  GetDlgItem $0 $HWNDPARENT 1028
  ShowWindow $0 0
  ; The classic NSIS resource has unnamed etched Static separators.
  ; Hide only direct parent Static controls with separator geometry.
  System::Alloc 16
  Pop $R9
  StrCpy $R8 0
  ${Do}
    System::Call 'user32::FindWindowEx(p $HWNDPARENT,p $R8,t "Static",p 0)p.R8'
    ${If} $R8 == 0
      ${ExitDo}
    ${EndIf}
    System::Call 'user32::GetWindowRect(p $R8,p $R9)'
    System::Call '*$R9(i .r0,i .r1,i .r2,i .r3)'
    IntOp $2 $2 - $0
    IntOp $3 $3 - $1
    ${If} $3 <= 3
    ${AndIf} $2 > 200
      ShowWindow $R8 0
    ${EndIf}
  ${Loop}
  System::Free $R9
  SetCtlColors $HWNDPARENT EDF8F8 07151A
  SetCtlColors $Dialog EDF8F8 07151A
  GetDlgItem $0 $HWNDPARENT 1
  ${NSD_SetText} $0 "Fechar"
  GetDlgItem $0 $HWNDPARENT 2
  ${NSD_SetText} $0 "Sair"
  CreateFont $TitleFont "Segoe UI" 16 700
  CreateFont $BodyFont "Segoe UI" 11 400
  CreateFont $HeadingFont "Segoe UI" 16 600
  InitPluginsDir
  File "/oname=$PLUGINSDIR\preview.bmp" "${CS_PREVIEW_ASSETS}\preview.bmp"
  File "/oname=$PLUGINSDIR\button-primary.bmp" "${CS_PREVIEW_ASSETS}\button-primary.bmp"
  File "/oname=$PLUGINSDIR\button-secondary.bmp" "${CS_PREVIEW_ASSETS}\button-secondary.bmp"
  ${NSD_CreateBitmap} 0 0 100% 100% ""
  Pop $Bg
  ${NSD_SetStretchedImage} $Bg "$PLUGINSDIR\preview.bmp" $BgImage
  System::Call 'user32::SetWindowPos(p $Bg,p 1,i 0,i 0,i 0,i 0,i 0x13)'
  ${NSD_CreateLabel} 34% 13% 61% 10% "Preparar uma experiência CyberSafe"
  Pop $Heading
  System::Call 'user32::SetWindowPos(p $Heading,p 0,i 0,i 0,i 0,i 0,i 0x13)'
  SendMessage $Heading ${WM_SETFONT} $HeadingFont 1
  SetCtlColors $Heading EDF8F8 07151A
  ${NSD_CreateLabel} 34% 27% 60% 16% "Composição nativa com recursos oficiais.$\r$\nPré-visualização: não instala nem altera o Windows."
  Pop $Body
  System::Call 'user32::SetWindowPos(p $Body,p 0,i 0,i 0,i 0,i 0,i 0x13)'
  SendMessage $Body ${WM_SETFONT} $BodyFont 1
  SetCtlColors $Body EDF8F8 07151A
  ${NSD_CreateButton} 34% 50% 27% 7% "Visão geral"
  Pop $Nav0
  System::Call 'user32::SetWindowPos(p $Nav0,p 0,i 0,i 0,i 0,i 0,i 0x13)'
  SendMessage $Nav0 ${WM_SETFONT} $BodyFont 1
  ${NSD_OnClick} $Nav0 Select0
  ${NSD_CreateButton} 64% 50% 27% 7% "Instalar"
  Pop $Nav1
  System::Call 'user32::SetWindowPos(p $Nav1,p 0,i 0,i 0,i 0,i 0,i 0x13)'
  SendMessage $Nav1 ${WM_SETFONT} $BodyFont 1
  ${NSD_OnClick} $Nav1 Select1
  ${NSD_CreateButton} 34% 60% 27% 7% "Atualizar"
  Pop $Nav2
  System::Call 'user32::SetWindowPos(p $Nav2,p 0,i 0,i 0,i 0,i 0,i 0x13)'
  SendMessage $Nav2 ${WM_SETFONT} $BodyFont 1
  ${NSD_OnClick} $Nav2 Select2
  ${NSD_CreateButton} 64% 60% 27% 7% "Reparar"
  Pop $Nav3
  System::Call 'user32::SetWindowPos(p $Nav3,p 0,i 0,i 0,i 0,i 0,i 0x13)'
  SendMessage $Nav3 ${WM_SETFONT} $BodyFont 1
  ${NSD_OnClick} $Nav3 Select3
  ${NSD_CreateButton} 34% 70% 57% 7% "Desinstalar"
  Pop $Nav4
  System::Call 'user32::SetWindowPos(p $Nav4,p 0,i 0,i 0,i 0,i 0,i 0x13)'
  SendMessage $Nav4 ${WM_SETFONT} $BodyFont 1
  ${NSD_OnClick} $Nav4 Select7
  ${NSD_CreateLabel} 34% 79% 61% 7% "ESTUDO VISUAL · nenhum progresso simulado"
  Pop $Status
  System::Call 'user32::SetWindowPos(p $Status,p 0,i 0,i 0,i 0,i 0,i 0x13)'
  SetCtlColors $Status 9E9BFF 07151A
  ${NSD_CreateButton} 76% 87% 20% 9% "Fechar estudo"
  Pop $0
  System::Call 'user32::SetWindowPos(p $0,p 0,i 0,i 0,i 0,i 0,i 0x13)'
  SendMessage $0 ${WM_SETFONT} $BodyFont 1
  !insertmacro CS_StyleButton $0 "$PLUGINSDIR\button-secondary.bmp"
  ${NSD_OnClick} $0 ClosePreview
  ; WS_EX_TRANSPARENT let the artwork cover the heading on first paint.
  ; Labels become opaque and are raised above the bitmap, in reverse order.
  System::Call 'user32::SetWindowLongW(p $Heading,i -20,i 0)'
  System::Call 'user32::SetWindowLongW(p $Body,i -20,i 0)'
  System::Call 'user32::SetWindowLongW(p $Status,i -20,i 0)'
  System::Call 'user32::SetWindowPos(p $Status,p 0,i 0,i 0,i 0,i 0,i 0x13)'
  System::Call 'user32::SetWindowPos(p $Body,p 0,i 0,i 0,i 0,i 0,i 0x13)'
  System::Call 'user32::SetWindowPos(p $Heading,p 0,i 0,i 0,i 0,i 0,i 0x13)'
  StrCpy $Mode "Boas-vindas"
  Call ModeSelect
  Call NavPaint
  ${GetParameters} $0
  ${GetOptions} $0 "/AUTOCLOSE" $1
  ${IfNot} ${Errors}
    GetFunctionAddress $0 ClosePreview
    nsDialogs::CreateTimer $0 90000
  ${EndIf}
  nsDialogs::Show
FunctionEnd
Function .onGUIEnd
  Call CSFreeButtonImages
FunctionEnd
