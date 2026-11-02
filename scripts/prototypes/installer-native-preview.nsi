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
Var Dialog
Var Heading
Var Body
Var Status
Var TitleFont
Var BodyFont
Var Mark
Var MarkImage
Var Mode
Var WindowDpi
Var LayoutWidth
Var LayoutHeight
Var ClientWidth
Var ClientHeight
Var HeadingFont

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
Function ModeChanged
  Pop $0
  Call ModeSelect
FunctionEnd
Function ModeSelect
  ${NSD_LB_GetSelection} $Mode $0
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
Function PreviewCreate
  nsDialogs::Create 1018
  Pop $Dialog
  ; Resize this preview window only; no OS preference or installation changes.
  System::Call 'user32::GetDpiForWindow(p $HWNDPARENT)i.r0'
  ${If} $0 == 0
    StrCpy $0 96
  ${EndIf}
  StrCpy $WindowDpi $0
  IntOp $LayoutWidth 720 * $WindowDpi
  IntOp $LayoutWidth $LayoutWidth / 96
  IntOp $LayoutHeight 460 * $WindowDpi
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
  SetCtlColors $HWNDPARENT F3F6FA 07131E
  SetCtlColors $Dialog F3F6FA 07131E
  GetDlgItem $0 $HWNDPARENT 1
  ${NSD_SetText} $0 "Fechar"
  GetDlgItem $0 $HWNDPARENT 2
  ${NSD_SetText} $0 "Sair"
  CreateFont $TitleFont "Segoe UI" 16 700
  CreateFont $BodyFont "Segoe UI" 11 400
  CreateFont $HeadingFont "Segoe UI" 16 600
  ${NSD_CreateIcon} 4% 6% 40u 40u ""
  Pop $Mark
  ${NSD_SetIconFromInstaller} $Mark $MarkImage
  ${NSD_CreateLabel} 16% 6% 80% 9% "CYBERSAFE ASSISTANT"
  Pop $0
  SendMessage $0 ${WM_SETFONT} $TitleFont 1
  SetCtlColors $0 70E1EB 07131E
  ${NSD_CreateLabel} 16% 16% 80% 6% "${CS_PRODUCT_VERSION} · setup em avaliação"
  Pop $0
  SetCtlColors $0 BDB2D1 07131E
  ${NSD_CreateLabel} 35% 30% 61% 13% "Preparar uma experiência CyberSafe"
  Pop $Heading
  SendMessage $Heading ${WM_SETFONT} $HeadingFont 1
  SetCtlColors $Heading F3F6FA 07131E
  ${NSD_CreateLabel} 35% 45% 59% 24% "Composição nativa com recursos oficiais.$\r$\nPré-visualização: não instala nem altera o Windows."
  Pop $Body
  SendMessage $Body ${WM_SETFONT} $BodyFont 1
  SetCtlColors $Body F3F6FA 07131E
  ${NSD_CreateListBox} 4% 30% 27% 49% ""
  Pop $Mode
  SendMessage $Mode ${WM_SETFONT} $BodyFont 1
  SetCtlColors $Mode B6C8D7 102330
  ${NSD_LB_AddString} $Mode "Boas-vindas"
  ${NSD_LB_AddString} $Mode "Instalação"
  ${NSD_LB_AddString} $Mode "Atualização"
  ${NSD_LB_AddString} $Mode "Reparação"
  ${NSD_LB_AddString} $Mode "Progresso"
  ${NSD_LB_AddString} $Mode "Conclusão"
  ${NSD_LB_AddString} $Mode "Erros"
  ${NSD_LB_AddString} $Mode "Desinstalação"
  ${NSD_LB_SelectString} $Mode "Boas-vindas"
  ${NSD_OnChange} $Mode ModeChanged
  ${NSD_CreateLabel} 35% 73% 61% 8% "ESTUDO VISUAL · nenhum progresso simulado"
  Pop $Status
  SetCtlColors $Status B6A4FF 07131E
  ${NSD_CreateLabel} 4% 89% 65% 7% "ESTUDO NATIVO · SEM PAYLOAD · NÃO INSTALA"
  Pop $0
  SetCtlColors $0 B6A4FF 07131E
  ${NSD_CreateButton} 76% 86% 20% 9% "Fechar estudo"
  Pop $0
  ${NSD_OnClick} $0 ClosePreview
  Call ModeSelect
  ${GetParameters} $0
  ${GetOptions} $0 "/AUTOCLOSE" $1
  ${IfNot} ${Errors}
    GetFunctionAddress $0 ClosePreview
    nsDialogs::CreateTimer $0 90000
  ${EndIf}
  nsDialogs::Show
FunctionEnd
