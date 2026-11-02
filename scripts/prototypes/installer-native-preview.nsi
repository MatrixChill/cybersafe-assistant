; Standalone visual feasibility prototype. No installation, registry, shortcuts,
; services, extraction payload, uninstaller or production installer hooks.
Unicode true
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
Function PreviewCreate
  nsDialogs::Create 1018
  Pop $Dialog
  SetCtlColors $Dialog F3F6FA 07131E
  GetDlgItem $0 $HWNDPARENT 1
  ${NSD_SetText} $0 "Fechar"
  GetDlgItem $0 $HWNDPARENT 2
  ${NSD_SetText} $0 "Sair"
  CreateFont $TitleFont "Segoe UI" 20 700
  CreateFont $BodyFont "Segoe UI" 10 400
  ${NSD_CreateIcon} 8u 4u 32u 32u ""
  Pop $Mark
  ${NSD_SetIconFromInstaller} $Mark $MarkImage
  ${NSD_CreateLabel} 50u 4u 245u 20u "CYBERSAFE ASSISTANT"
  Pop $0
  SendMessage $0 ${WM_SETFONT} $TitleFont 1
  SetCtlColors $0 70E1EB 07131E
  ${NSD_CreateLabel} 50u 27u 245u 14u "${CS_PRODUCT_VERSION} · proposta, não aprovada"
  Pop $0
  SetCtlColors $0 BDB2D1 07131E
  ${NSD_CreateLabel} 2% 44u 96% 18u "Preparar uma experiência CyberSafe"
  Pop $Heading
  SendMessage $Heading ${WM_SETFONT} $BodyFont 1
  SetCtlColors $Heading F3F6FA 07131E
  ${NSD_CreateLabel} 2% 65u 96% 34u "Composição nativa com recursos oficiais.$\r$\nPré-visualização: não instala nem altera o Windows."
  Pop $Body
  SendMessage $Body ${WM_SETFONT} $BodyFont 1
  SetCtlColors $Body F3F6FA 07131E
  ${NSD_CreateButton} 2% 105u 30% 20u "Instalar · proposta"
  Pop $0
  ${NSD_OnClick} $0 ModeInstall
  ${NSD_CreateButton} 35% 105u 30% 20u "Reparar · proposta"
  Pop $0
  ${NSD_OnClick} $0 ModeRepair
  ${NSD_CreateButton} 68% 105u 30% 20u "Atualizar · proposta"
  Pop $0
  ${NSD_OnClick} $0 ModeUpgrade
  ${NSD_CreateLabel} 2% 130u 96% 12u "ESTUDO VISUAL · nenhum progresso simulado"
  Pop $Status
  SetCtlColors $Status B6A4FF 07131E
  ${GetParameters} $0
  ${GetOptions} $0 "/AUTOCLOSE" $1
  ${IfNot} ${Errors}
    GetFunctionAddress $0 ClosePreview
    nsDialogs::CreateTimer $0 90000
  ${EndIf}
  nsDialogs::Show
FunctionEnd
