import io

P = 'main.cpp'
s = open(P, 'r', encoding='utf-8').read().replace('\r\n', '\n')


def rep(old, new):
    global s
    if old not in s:
        raise SystemExit('MISSING: ' + old[:80])
    s = s.replace(old, new, 1)


rep('static int g_press = -1;',
    'static int g_press = -1;\n'
    'static int g_winHover = -1, g_winPress = -1;\n'
    'static RECT g_winBtn[3];\n'
    'static HICON g_appIcon = nullptr;')

# --- asset resolver shared by bitmaps and the icon ---
start = s.index('static bool LoadPng(')
end = s.index('static void LoadImages(){', start)
s = s[:start] + '''static std::wstring FindAsset(const wchar_t* rel){
  wchar_t exe[MAX_PATH];
  GetModuleFileNameW(nullptr, exe, MAX_PATH);
  std::wstring dir(exe);
  const wchar_t sep = static_cast<wchar_t>(92);
  size_t cut = dir.find_last_of(sep);
  if(cut != std::wstring::npos) dir = dir.substr(0, cut);
  std::wstring bases[3] = { L"", dir, dir + L"/../.." };
  for(int i = 0; i < 3; i++){
    std::wstring full = bases[i].empty() ? std::wstring(rel) : bases[i] + L"/" + rel;
    if(GetFileAttributesW(full.c_str()) != INVALID_FILE_ATTRIBUTES) return full;
  }
  return std::wstring();
}
static bool LoadPng(const wchar_t* rel, Bitmap** out){
  std::wstring full = FindAsset(rel);
  if(full.empty()) return false;
  Bitmap* b = new Bitmap(full.c_str());
  if(b->GetLastStatus() == Ok){ *out = b; return true; }
  delete b;
  return false;
}
''' + s[end:]

# --- layout: proportional right column plus window control rects ---
rep('  float bx = S(600), bw = S(232), bh = S(58), gap = S(18), by = H - S(268);',
    '''  float bx = W * 0.536f, bw = S(232), bh = S(58), gap = S(18), by = H - S(268);
  float wbw = S(46), wbh = S(34), wgap = S(8);
  float wx = W - S(20) - wbw * 3 - wgap * 2;
  for(int i = 0; i < 3; i++){
    g_winBtn[i].left = (LONG)(wx + i * (wbw + wgap));
    g_winBtn[i].right = (LONG)(wx + i * (wbw + wgap) + wbw);
    g_winBtn[i].top = (LONG)S(11);
    g_winBtn[i].bottom = (LONG)(S(11) + wbh);
  }''')

rep('  float cx = S(600);', '  float cx = W * 0.536f;')

# --- title bar icon + title ---
rep('    DrawTextAt(g, kTitle, RectF(S(48), S(18), W-S(220), S(28)), S(15), kText);',
    '''    if(g_appIcon) DrawIconEx(mem, (int)S(20), (int)S(15), g_appIcon, (int)S(22), (int)S(22), 0, nullptr, DI_NORMAL);
    DrawTextAt(g, kTitle, RectF(S(54), S(18), W - S(260), S(28)), S(15), kText);''')

# --- real window controls, with hover and pressed states ---
rep('''    { Pen p(kMuted, S(1.4f));
      g.DrawLine(&p, W-S(150), S(28), W-S(136), S(28));
      g.DrawRectangle(&p, W-S(104), S(22), S(11), S(11));
      g.DrawLine(&p, W-S(66), S(22), W-S(55), S(33));
      g.DrawLine(&p, W-S(55), S(22), W-S(66), S(33)); }''',
    '''    for(int i = 0; i < 3; i++){
      RectF br((float)g_winBtn[i].left, (float)g_winBtn[i].top,
               (float)(g_winBtn[i].right - g_winBtn[i].left), (float)(g_winBtn[i].bottom - g_winBtn[i].top));
      bool hv = (i == g_winHover), pr = (i == g_winPress && hv);
      if(hv){ SolidBrush hb(i == 2 ? Color(210, 190, 40, 52) : Color(255, 30, 74, 86)); FillRound(g, br, S(8), hb); }
      if(pr){ SolidBrush pb(i == 2 ? Color(255, 150, 30, 40) : Color(255, 18, 52, 62)); FillRound(g, br, S(8), pb); }
      Pen gp(i == 2 && hv ? Color(255, 255, 170, 178) : Color(240, 198, 226, 230), S(1.4f));
      float mx = br.X + br.Width / 2, my = br.Y + br.Height / 2;
      if(i == 0) g.DrawLine(&gp, mx - S(6), my, mx + S(6), my);
      else if(i == 1){
        if(IsZoomed(hwnd)){
          g.DrawRectangle(&gp, mx - S(5), my - S(6), S(9), S(9));
          g.DrawRectangle(&gp, mx - S(2), my - S(3), S(9), S(9));
        } else g.DrawRectangle(&gp, mx - S(5), my - S(5), S(10), S(10));
      } else {
        g.DrawLine(&gp, mx - S(5), my - S(5), mx + S(5), my + S(5));
        g.DrawLine(&gp, mx + S(5), my - S(5), mx - S(5), my + S(5));
      }
    }''')

# --- scene centred in the left column so resize keeps balance ---
rep('    DrawOrbitals(g, RectF(S(26), S(118), S(548), S(442)));',
    '    DrawOrbitals(g, RectF(S(26), (H - S(442)) * 0.5f + S(10), S(548), S(442)));')

# --- hit testing: controls stay client, rest of the bar drags ---
rep('        if(p.y < (int)S(52)) return HTCAPTION;',
    '''        if(p.y < (int)S(52)){
          for(int i = 0; i < 3; i++){
            if(p.x >= g_winBtn[i].left && p.x < g_winBtn[i].right &&
               p.y >= g_winBtn[i].top && p.y < g_winBtn[i].bottom) return HTCLIENT;
          }
          return HTCAPTION;
        }''')

rep('''    case WM_MOUSEMOVE: {
      int x = GET_X_LPARAM(lp), y = GET_Y_LPARAM(lp), hit = -1;''',
    '''    case WM_MOUSEMOVE: {
      int x = GET_X_LPARAM(lp), y = GET_Y_LPARAM(lp), hit = -1, wh = -1;
      for(int i = 0; i < 3; i++){
        if(x >= g_winBtn[i].left && x < g_winBtn[i].right && y >= g_winBtn[i].top && y < g_winBtn[i].bottom) wh = i;
      }
      if(wh != g_winHover){ g_winHover = wh; InvalidateRect(hwnd, nullptr, FALSE); }''')

rep('''      RECT rc; GetClientRect(hwnd, &rc);
      if(y < (int)S(52) && x > rc.right - (int)S(120)){ DestroyWindow(hwnd); return 0; }''',
    '''      for(int i = 0; i < 3; i++){
        if(x >= g_winBtn[i].left && x < g_winBtn[i].right && y >= g_winBtn[i].top && y < g_winBtn[i].bottom){
          g_winPress = i; InvalidateRect(hwnd, nullptr, FALSE); return 0;
        }
      }''')

rep('''    case WM_LBUTTONUP: {
      int x = GET_X_LPARAM(lp), y = GET_Y_LPARAM(lp);
      g_press = -1;''',
    '''    case WM_LBUTTONUP: {
      int x = GET_X_LPARAM(lp), y = GET_Y_LPARAM(lp);
      g_press = -1;
      if(g_winPress >= 0){
        int w = g_winPress; g_winPress = -1;
        bool inside = x >= g_winBtn[w].left && x < g_winBtn[w].right && y >= g_winBtn[w].top && y < g_winBtn[w].bottom;
        InvalidateRect(hwnd, nullptr, FALSE);
        if(inside){
          if(w == 0) ShowWindow(hwnd, SW_MINIMIZE);
          else if(w == 1) ShowWindow(hwnd, IsZoomed(hwnd) ? SW_RESTORE : SW_MAXIMIZE);
          else DestroyWindow(hwnd);
        }
        return 0;
      }''')

# --- region follows the window state ---
rep('''    case WM_SIZE:
      Layout(hwnd);''',
    '''    case WM_SIZE:
      Layout(hwnd);
      if(IsZoomed(hwnd) || IsIconic(hwnd)) SetWindowRgn(hwnd, nullptr, TRUE);
      else {
        RECT wr; GetClientRect(hwnd, &wr);
        SetWindowRgn(hwnd, CreateRoundRectRgn(0, 0, wr.right + 1, wr.bottom + 1, (int)S(16), (int)S(16)), TRUE);
      }''')

rep('    case WM_PRINTCLIENT: {',
    '''    case WM_GETMINMAXINFO: {
      MINMAXINFO* mm = (MINMAXINFO*)lp;
      MONITORINFO mi; mi.cbSize = sizeof(mi);
      if(GetMonitorInfoW(MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST), &mi)){
        mm->ptMaxPosition.x = mi.rcWork.left - mi.rcMonitor.left;
        mm->ptMaxPosition.y = mi.rcWork.top - mi.rcMonitor.top;
        mm->ptMaxSize.x = mi.rcWork.right - mi.rcWork.left;
        mm->ptMaxSize.y = mi.rcWork.bottom - mi.rcWork.top;
        mm->ptMinTrackSize.x = (LONG)S(960);
        mm->ptMinTrackSize.y = (LONG)S(660);
      }
      return 0;
    }
    case WM_CLOSE:
      DestroyWindow(hwnd);
      return 0;
    case WM_NCLBUTTONDBLCLK:
      if(wp == HTCAPTION) ShowWindow(hwnd, IsZoomed(hwnd) ? SW_RESTORE : SW_MAXIMIZE);
      return 0;
    case WM_PRINTCLIENT: {''')

# --- taskbar entry and official icon ---
rep('HWND hwnd = CreateWindowExW(0, kClass, kTitle, WS_POPUP, x, y, w, h, nullptr, nullptr, hInst, nullptr);',
    '''std::wstring icoPath = FindAsset(L"assets/branding/icon/cybersafe.ico");
  if(!icoPath.empty()) g_appIcon = (HICON)LoadImageW(nullptr, icoPath.c_str(), IMAGE_ICON, 0, 0, LR_LOADFROMFILE | LR_DEFAULTSIZE);
  HWND hwnd = CreateWindowExW(WS_EX_APPWINDOW, kClass, kTitle, WS_POPUP, x, y, w, h, nullptr, nullptr, hInst, nullptr);
  if(g_appIcon){
    SendMessageW(hwnd, WM_SETICON, ICON_BIG, (LPARAM)g_appIcon);
    SendMessageW(hwnd, WM_SETICON, ICON_SMALL, (LPARAM)g_appIcon);
  }''')

open(P, 'w', encoding='utf-8', newline='\n').write(s)
print('patched ok')
