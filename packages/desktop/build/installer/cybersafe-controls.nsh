; Native bitmap buttons keep their real caption, tab stop and click semantics.
; The surface is generated from official Core tokens; text is drawn at runtime
; so all existing installer languages keep their labels. No external plugin.
!ifndef CS_NATIVE_CONTROLS
!define CS_NATIVE_CONTROLS
Var CSButtonHead
!macro CS_StyleButton HWND SURFACE
  Push "${SURFACE}"
  Push ${HWND}
  Call CSStyleButton
!macroend
Function CSStyleButton
  Exch $0
  Exch
  Exch $1
  Push $2
  Push $3
  Push $4
  Push $5
  Push $6
  Push $7
  Push $8
  Push $9
  Push $R0
  Push $R1
  System::Alloc 16
  Pop $2
  System::Call 'user32::GetClientRect(p r0,p r2)'
  System::Call '*$2(i,i,i .r3,i .r4)'
  IntOp $3 $3 - 4
  IntOp $4 $4 - 4
  System::Call 'user32::LoadImage(p 0,t r1,i 0,i r3,i r4,i 0x2010)p.r5'
  ${If} $5 != 0
    System::Call 'gdi32::CreateCompatibleDC(p 0)p.r6'
    System::Call 'gdi32::SelectObject(p r6,p r5)p.r7'
    System::Call 'user32::SendMessage(p r0,i 0x31,p 0,p 0)p.r8'
    ${If} $8 == 0
      System::Call 'gdi32::GetStockObject(i 17)p.r8'
    ${EndIf}
    System::Call 'gdi32::SelectObject(p r6,p r8)p.R0'
    System::Call 'gdi32::SetBkMode(p r6,i 1)'
    System::Call 'gdi32::SetTextColor(p r6,i 0x00F8F8ED)'
    System::Call 'user32::GetWindowText(p r0,t .r9,i 1024)'
    System::Call '*$2(i 0,i 0,i r3,i r4)'
    System::Call 'user32::DrawText(p r6,t r9,i -1,p r2,i 0x8025)'
    System::Call 'gdi32::SelectObject(p r6,p R0)'
    System::Call 'gdi32::SelectObject(p r6,p r7)'
    System::Call 'gdi32::DeleteDC(p r6)'
    System::Call 'uxtheme::SetWindowTheme(p r0,w "",w "")'
    ${NSD_AddStyle} $0 0x8080 ; BS_BITMAP | BS_FLAT; native keyboard semantics retained
    SendMessage $0 0xF7 0 $5
    ; Exclude only the classic pushbutton frame. The actual BUTTON retains
    ; its caption, focus, tab stop, hit testing and notifications.
    IntOp $3 $3 + 2
    IntOp $4 $4 + 2
    System::Call 'gdi32::CreateRoundRectRgn(i 2,i 2,i r3,i r4,i 10,i 10)p.r8'
    System::Call 'user32::SetWindowRgn(p r0,p r8,i 1)i.r9'
    ${If} $9 == 0
      System::Call 'gdi32::DeleteObject(p r8)'
    ${EndIf}
    ; Track owned HBITMAPs, including revisits, and release at GUI teardown.
    System::Alloc 16
    Pop $R1
    System::Call '*$R1(p r5,p $CSButtonHead)'
    StrCpy $CSButtonHead $R1
  ${EndIf}
  System::Free $2
  Pop $R1
  Pop $R0
  Pop $9
  Pop $8
  Pop $7
  Pop $6
  Pop $5
  Pop $4
  Pop $3
  Pop $2
  Pop $1
  Pop $0
FunctionEnd
Function CSFreeButtonImages
  Push $0
  Push $1
  Push $2
  ${Do}
    ${If} $CSButtonHead == 0
    ${OrIf} $CSButtonHead == ""
      ${ExitDo}
    ${EndIf}
    StrCpy $2 $CSButtonHead
    System::Call '*$2(p .r0,p .r1)'
    System::Call 'gdi32::DeleteObject(p r0)'
    StrCpy $CSButtonHead $1
    System::Free $2
  ${Loop}
  Pop $2
  Pop $1
  Pop $0
FunctionEnd
!endif
