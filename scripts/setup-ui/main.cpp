// CyberSafe setup presentation layer.
// Native Win32 + GDI+. One small exe, no extra runtime.
// PREVIEW build: buttons move between pages; nothing is installed.
#define _WIN32_WINNT 0x0A00
#define UNICODE
#define _UNICODE
#include <windows.h>
#include <windowsx.h>
#include <gdiplus.h>
#include <shellapi.h>
#include <stdio.h>
#include <string>
#include <cmath>
#include <vector>
using namespace Gdiplus;

static const wchar_t* kClass = L"CyberSafeSetupUI";
static const wchar_t* kTitle = L"CyberSafe Assistant \u2014 Instala\u00e7\u00e3o";
static const Color kBgTop(255, 6, 26, 34), kBgBot(255, 3, 11, 16);
static const Color kCyan(255, 22, 214, 193), kCyanBright(255, 43, 232, 210);
static const Color kText(255, 237, 248, 248), kMuted(255, 126, 164, 168);

struct Btn { RECT r; int id; const wchar_t* label; int icon; bool primary; bool enabled; };
static std::vector<Btn> g_buttons;
static int g_page = 0, g_hover = -1, g_focus = 0, g_dpi = 96;
static Bitmap *g_scene = nullptr, *g_sceneSoft = nullptr, *g_lockup = nullptr, *g_symbol = nullptr;
static void BuildSceneSoft(int w);
static void BuildCore();
static void DrawContain(Graphics& g, Bitmap* b, RectF box);
static int g_progress = 0;
static bool g_openApp = true;
static std::wstring g_note;
static Bitmap *g_core = nullptr;
static double g_phase = 0.0;
static bool g_anim = true;
static ULONGLONG g_last = 0;
static int g_press = -1;

static float S(float v){ return v * g_dpi / 96.0f; }

static bool FileExistsW(const std::wstring& p){
  DWORD a = GetFileAttributesW(p.c_str());
  return a != INVALID_FILE_ATTRIBUTES;
}
static bool LoadPng(const wchar_t* rel, Bitmap** out){
  wchar_t exe[MAX_PATH];
  GetModuleFileNameW(nullptr, exe, MAX_PATH);
  std::wstring dir(exe);
  const wchar_t sep = static_cast<wchar_t>(92);
  size_t cut = dir.find_last_of(sep);
  if(cut != std::wstring::npos) dir = dir.substr(0, cut);
  std::wstring bases[3] = { L"", dir, dir + L"/../.." };
  for(int i = 0; i < 3; i++){
    std::wstring full = bases[i].empty() ? std::wstring(rel) : bases[i] + L"/" + rel;
    if(FileExistsW(full)){
      Bitmap* b = new Bitmap(full.c_str());
      if(b->GetLastStatus() == Ok){ *out = b; return true; }
      delete b;
    }
  }
  return false;
}
static void LoadImages(){
  LoadPng(L"assets/branding/scene/orbital-b-scene.png", &g_scene);
  LoadPng(L"assets/branding/source/07_CyberSafe_horizontal_lockup.png", &g_lockup);
  LoadPng(L"assets/branding/source/symbol.png", &g_symbol);
  BuildSceneSoft(960);
}

static void BuildSceneSoft(int w){
  if(!g_scene) return;
  int sw = (int)g_scene->GetWidth(), sh = (int)g_scene->GetHeight();
  if(sw <= 0 || sh <= 0) return;
  int h = (int)((float)w * sh / sw + 0.5f);
  Bitmap* tmp = new Bitmap(w, h, PixelFormat32bppARGB);
  { Graphics gg(tmp);
    gg.SetInterpolationMode(InterpolationModeHighQualityBicubic);
    gg.DrawImage(g_scene, RectF(0, 0, (REAL)w, (REAL)h)); }
  BitmapData bd; Rect rc(0, 0, w, h);
  if(tmp->LockBits(&rc, ImageLockModeRead | ImageLockModeWrite, PixelFormat32bppARGB, &bd) == Ok){
    BYTE* base = (BYTE*)bd.Scan0;
    float fx = w * 0.18f, fy = h * 0.18f;
    for(int y = 0; y < h; y++){
      BYTE* row = base + (size_t)y * bd.Stride;
      float dy = fminf((float)y, (float)(h - 1 - y)) / fy;
      for(int x = 0; x < w; x++){
        float dx = fminf((float)x, (float)(w - 1 - x)) / fx;
        float t = dx < dy ? dx : dy; if(t > 1.0f) t = 1.0f;
        t = t * t * (3.0f - 2.0f * t);
        row[x * 4 + 3] = (BYTE)(row[x * 4 + 3] * t);
      }
    }
    tmp->UnlockBits(&bd);
  }
  g_sceneSoft = tmp;
}

static void DrawContain(Graphics& g, Bitmap* b, RectF box){
  if(!b) return;
  float iw = (float)b->GetWidth(), ih = (float)b->GetHeight();
  if(iw <= 0 || ih <= 0) return;
  float sc = fminf(box.Width / iw, box.Height / ih);
  float w = iw * sc, h = ih * sc;
  g.DrawImage(b, RectF(box.X + (box.Width - w) / 2.0f, box.Y + (box.Height - h) / 2.0f, w, h));
}

static void BuildCore(){
  if(!g_scene) return;
  const int ox = 330, oy = 155, cw = 300, ch = 330;
  Bitmap* b = new Bitmap(cw, ch, PixelFormat32bppARGB);
  { Graphics gg(b);
    gg.SetInterpolationMode(InterpolationModeHighQualityBicubic);
    gg.DrawImage(g_scene, RectF(0, 0, (REAL)cw, (REAL)ch), ox, oy, cw, ch, UnitPixel); }
  BitmapData bd; Rect rc(0, 0, cw, ch);
  if(b->LockBits(&rc, ImageLockModeRead | ImageLockModeWrite, PixelFormat32bppARGB, &bd) == Ok){
    const POINT poly[6] = { {150,10}, {288,94}, {288,242}, {150,320}, {12,242}, {12,94} };
    for(int y = 0; y < ch; y++){
      BYTE* row = (BYTE*)bd.Scan0 + (size_t)y * bd.Stride;
      for(int x = 0; x < cw; x++){
        bool in = false;
        for(int i = 0, j = 5; i < 6; j = i++){
          if(((poly[i].y > y) != (poly[j].y > y)) &&
             (x < (poly[j].x - poly[i].x) * (y - poly[i].y) / (poly[j].y - poly[i].y) + poly[i].x)) in = !in;
        }
        if(!in) row[x * 4 + 3] = 0;
      }
    }
    b->UnlockBits(&bd);
  }
  g_core = b;
}

struct V3 { float x, y, z; };
static V3 RotX(V3 p, float a){ float c = cosf(a), s = sinf(a); return { p.x, p.y * c - p.z * s, p.y * s + p.z * c }; }
static V3 RotY(V3 p, float a){ float c = cosf(a), s = sinf(a); return { p.x * c + p.z * s, p.y, -p.x * s + p.z * c }; }
static V3 RotZ(V3 p, float a){ float c = cosf(a), s = sinf(a); return { p.x * c - p.y * s, p.x * s + p.y * c, p.z }; }

// Same geometry as CoreScene: torus radii 1.45 / 1.75, camera z=7 fov 35,
// ring pose from orbitalRingPose(phase, i, 'depth'), logo plane at z=0.265.
static void DrawOrbitals(Graphics& g, RectF box){
  const float sc = fminf(box.Width / 960.0f, box.Height / 640.0f);
  const float offX = box.X + (box.Width - 960.0f * sc) / 2.0f;
  const float offY = box.Y + (box.Height - 640.0f * sc) / 2.0f;
  PointF c(offX + 480.0f * sc, offY + 320.0f * sc);
  const float f = 1014.9f * sc;
  const float t = (float)g_phase;
  const float twoPi = 6.2831853f;
  const float gy = sinf(t * 0.30f) * 0.06f;
  const float gx = cosf(t * 0.25f) * 0.04f;
  const float zLogo = 0.265f;

  { GraphicsPath hp; hp.AddEllipse(c.X - 188 * sc, c.Y - 188 * sc, 376 * sc, 376 * sc);
    PathGradientBrush hb(&hp);
    hb.SetCenterColor(Color(40, 28, 205, 195));
    Color hs(0, 20, 180, 190); int n = 1; hb.SetSurroundColors(&hs, &n);
    g.FillPath(&hb, &hp); }

  struct Ring { float R, rx, ry, rz; BYTE r, gr, b; double speed; };
  Ring rings[2];
  rings[0] = { 1.45f, -0.55f + sinf(t * 0.24f) * 0.12f, fmodf(0.35f + t * 0.22f, twoPi), fmodf(t * 0.08f, twoPi), 92, 230, 237, 0.10 };
  rings[1] = { 1.75f, 0.65f + cosf(t * 0.19f) * 0.16f, fmodf(-0.40f - t * 0.16f, twoPi), fmodf(-t * 0.11f, twoPi), 156, 149, 238, -0.08 };

  auto project = [&](const Ring& R, float a, float& sx, float& sy, float& z){
    V3 p = { R.R * cosf(a), R.R * sinf(a), 0.0f };
    p = RotZ(p, R.rz); p = RotY(p, R.ry); p = RotX(p, R.rx);
    p = RotY(p, gy); p = RotX(p, gx);
    float den = 7.0f - p.z; if(den < 0.6f) den = 0.6f;
    sx = c.X + p.x * f / den;
    sy = c.Y - p.y * f / den;
    z = p.z;
  };

  const int N = 120;
  const float w0 = 0.026f * f / 7.0f;

  for(int pass = 0; pass < 2; pass++){
    if(pass == 1){
      const float R = 0.95f, k = f / 7.0f;
      PointF hex[6], back[6];
      for(int i = 0; i < 6; i++){
        float a = -1.5707963f + i * 1.0471976f;
        hex[i] = PointF(c.X + cosf(a) * R * k, c.Y + sinf(a) * R * k);
        back[i] = PointF(hex[i].X + 0.05f * k, hex[i].Y + 0.07f * k);
      }
      SolidBrush eb(Color(255, 5, 28, 40));
      g.FillPolygon(&eb, back, 6);
      LinearGradientBrush fb(PointF(c.X, c.Y - R * k), PointF(c.X, c.Y + R * k),
                             Color(255, 13, 76, 102), Color(255, 4, 30, 46));
      g.FillPolygon(&fb, hex, 6);
      Pen edge(Color(255, 48, 126, 150), 1.5f * sc);
      g.DrawPolygon(&edge, hex, 6);
      if(g_symbol){
        float sw = 1.8f * f / (7.0f - zLogo);
        g.DrawImage(g_symbol, RectF(c.X - sw / 2, c.Y - sw / 2, sw, sw));
      }
    }
    for(int i = 0; i < 2; i++){
      Ring& R = rings[i];
      for(int k = 0; k < N; k++){
        float a0 = twoPi * k / N, a1 = twoPi * (k + 1) / N;
        float x0, y0, z0, x1, y1, z1;
        project(R, a0, x0, y0, z0);
        project(R, a1, x1, y1, z1);
        float zm = (z0 + z1) * 0.5f;
        bool front = zm > zLogo;
        if((pass == 1) != front) continue;
        int alpha = (int)(120 + 135 * ((zm + 1.8f) / 3.6f));
        if(alpha < 70) alpha = 70; if(alpha > 255) alpha = 255;
        Pen pen(Color((BYTE)alpha, R.r, R.gr, R.b), front ? w0 : w0 * 0.85f);
        g.DrawLine(&pen, x0, y0, x1, y1);
      }
      for(int sp = 0; sp < 6; sp++){
        float a = (float)(t * R.speed * twoPi) - sp * 0.055f;
        float sx, sy, z;
        project(R, a, sx, sy, z);
        if((pass == 1) != (z > zLogo)) continue;
        float rad = (sp == 0 ? 3.2f : 2.5f - sp * 0.3f) * sc;
        if(rad <= 0.2f) continue;
        SolidBrush sb(Color((BYTE)(sp == 0 ? 240 : 135), 240, 255, 255));
        g.FillEllipse(&sb, sx - rad, sy - rad, rad * 2, rad * 2);
      }
    }
  }
}

static GraphicsPath* RoundRectPath(RectF r, float rad){
  GraphicsPath* p = new GraphicsPath(); float d = rad * 2;
  p->AddArc(r.X, r.Y, d, d, 180, 90);
  p->AddArc(r.GetRight() - d, r.Y, d, d, 270, 90);
  p->AddArc(r.GetRight() - d, r.GetBottom() - d, d, d, 0, 90);
  p->AddArc(r.X, r.GetBottom() - d, d, d, 90, 90);
  p->CloseFigure(); return p;
}
static void FillRound(Graphics& g, RectF r, float rad, Brush& b){
  GraphicsPath* p = RoundRectPath(r, rad); g.FillPath(&b, p); delete p;
}
static void StrokeRound(Graphics& g, RectF r, float rad, Color c, float w){
  GraphicsPath* p = RoundRectPath(r, rad); Pen pen(c, w); g.DrawPath(&pen, p); delete p;
}
static void DrawTextAt(Graphics& g, const wchar_t* s, RectF r, float size, Color c,
                       int style = FontStyleRegular, StringAlignment al = StringAlignmentNear, bool wrap = false){
  FontFamily fam(L"Segoe UI");
  Font f(&fam, size, style, UnitPixel);
  SolidBrush b(c);
  StringFormat sf;
  sf.SetAlignment(al);
  sf.SetLineAlignment(StringAlignmentNear);
  sf.SetTrimming(StringTrimmingEllipsisCharacter);
  if(!wrap) sf.SetFormatFlags(StringFormatFlagsNoWrap);
  g.DrawString(s, -1, &f, r, &sf, &b);
}

static void Icon(Graphics& g, int kind, RectF r, Color c){
  Pen pen(c, S(1.8f));
  pen.SetLineJoin(LineJoinRound);
  float cx = r.X + r.Width / 2, cy = r.Y + r.Height / 2, w = r.Width * 0.52f;
  switch(kind){
    case 0:
      g.DrawLine(&pen, cx, cy - w/2, cx, cy + w/4);
      g.DrawLine(&pen, cx - w/3, cy, cx, cy + w/4);
      g.DrawLine(&pen, cx + w/3, cy, cx, cy + w/4);
      g.DrawLine(&pen, cx - w/2, cy + w/2, cx + w/2, cy + w/2);
      break;
    case 1:
      g.DrawLine(&pen, cx - w/3, cy + w/3, cx + w/4, cy - w/4);
      { SolidBrush b(c); g.FillEllipse(&b, cx + w/6, cy - w/2, w*0.42f, w*0.42f); }
      break;
    case 2:
      g.DrawRectangle(&pen, cx - w/3, cy - w/3, w*0.66f, w*0.75f);
      g.DrawLine(&pen, cx - w/2, cy - w/3, cx + w/2, cy - w/3);
      g.DrawLine(&pen, cx - w/6, cy - w/2, cx + w/6, cy - w/2);
      break;
    case 3:
      g.DrawRectangle(&pen, cx - w/3, cy - w/2, w*0.66f, w);
      g.DrawLine(&pen, cx - w/6, cy - w/6, cx + w/6, cy - w/6);
      g.DrawLine(&pen, cx - w/6, cy + w/8, cx + w/6, cy + w/8);
      break;
    case 4:
      g.DrawEllipse(&pen, cx - w/2, cy - w/2, w, w);
      g.DrawLine(&pen, cx, cy - w/6, cx, cy + w/3);
      break;
    default:
      g.DrawRectangle(&pen, cx - w/2, cy - w/3, w, w*0.66f);
      g.DrawLine(&pen, cx - w/2, cy - w/3, cx, cy - w/2);
      g.DrawLine(&pen, cx + w/2, cy - w/3, cx, cy - w/2);
      break;
  }
}

static void Layout(HWND hwnd){
  RECT rc; GetClientRect(hwnd, &rc);
  g_buttons.clear();
  float W = (float)rc.right, H = (float)rc.bottom;
  float bx = S(600), bw = S(232), bh = S(58), gap = S(18), by = H - S(268);
  auto add = [&](int i, const wchar_t* l, int icon, bool primary, bool enabled){
    Btn b;
    b.id = (int)g_buttons.size();
    b.label = l; b.icon = icon; b.primary = primary; b.enabled = enabled;
    int col = i % 2, row = i / 2;
    b.r = { (LONG)(bx + col*(bw+gap)), (LONG)(by + row*(bh+gap)),
            (LONG)(bx + col*(bw+gap) + bw), (LONG)(by + row*(bh+gap) + bh) };
    g_buttons.push_back(b);
  };
  if(g_page == 0){
    add(0, L"Instalar", 0, true, true);
    add(1, L"Reparar", 1, false, false);
    add(2, L"Desinstalar", 2, false, false);
    add(3, L"Licen\u00e7a", 3, false, true);
  } else if(g_page == 1 || g_page == 2){
    float w = S(200);
    Btn b; b.id = 0; b.label = L"Voltar"; b.icon = -1; b.primary = false; b.enabled = true;
    b.r = { (LONG)S(600), (LONG)by, (LONG)(S(600)+w), (LONG)(by+bh) };
    g_buttons.push_back(b);
    Btn c; c.id = 1; c.label = (g_page==1)? L"Continuar" : L"Instalar";
    c.icon = (g_page==2)? 0 : -1; c.primary = true; c.enabled = true;
    c.r = { (LONG)(W - S(56) - w), (LONG)by, (LONG)(W - S(56)), (LONG)(by+bh) };
    g_buttons.push_back(c);
  } else if(g_page == 3){
    Btn c; c.id = 0; c.label = L"Cancelar"; c.icon = -1; c.primary = false; c.enabled = true;
    c.r = { (LONG)(W - S(56) - S(200)), (LONG)by, (LONG)(W - S(56)), (LONG)(by+bh) };
    g_buttons.push_back(c);
  } else {
    Btn c; c.id = 0; c.label = L"Concluir"; c.icon = -1; c.primary = true; c.enabled = true;
    c.r = { (LONG)(W - S(56) - S(200)), (LONG)by, (LONG)(W - S(56)), (LONG)(by+bh) };
    g_buttons.push_back(c);
  }
}

static void Paint(HWND hwnd, HDC hdc){
  RECT rc; GetClientRect(hwnd, &rc);
  HDC mem = CreateCompatibleDC(hdc);
  HBITMAP bmp = CreateCompatibleBitmap(hdc, rc.right, rc.bottom);
  HGDIOBJ old = SelectObject(mem, bmp);
  {
    Graphics g(mem);
    g.SetSmoothingMode(SmoothingModeAntiAlias);
    g.SetTextRenderingHint(TextRenderingHintClearTypeGridFit);
    g.SetInterpolationMode(InterpolationModeHighQualityBicubic);
    g.SetPixelOffsetMode(PixelOffsetModeHighQuality);
    float W = (float)rc.right, H = (float)rc.bottom;

    LinearGradientBrush bg(PointF(0,0), PointF(0,H), kBgTop, kBgBot);
    g.FillRectangle(&bg, (REAL)0, (REAL)0, (REAL)W, (REAL)H);

    { GraphicsPath p; p.AddEllipse(S(-180), S(60), S(620), S(620));
      PathGradientBrush pb(&p);
      pb.SetCenterColor(Color(26,22,214,193));
      Color c(0,22,214,193); int n = 1; pb.SetSurroundColors(&c, &n);
      g.FillPath(&pb, &p); }
    { GraphicsPath p; p.AddEllipse(S(700), S(-240), S(720), S(720));
      PathGradientBrush pb(&p);
      pb.SetCenterColor(Color(18,22,214,193));
      Color c(0,22,214,193); int n = 1; pb.SetSurroundColors(&c, &n);
      g.FillPath(&pb, &p); }

    RectF card(S(28), S(58), W - S(56), H - S(86));
    SolidBrush cardB(Color(210,6,22,29));
    FillRound(g, card, S(20), cardB);
    StrokeRound(g, card, S(20), Color(70,22,214,193), S(1.2f));

    DrawTextAt(g, kTitle, RectF(S(48), S(18), W-S(220), S(28)), S(15), kText);
    { Pen p(Color(60,18,59,68), S(1)); g.DrawLine(&p, S(28), S(58), W-S(28), S(58)); }
    { Pen p(kMuted, S(1.4f));
      g.DrawLine(&p, W-S(150), S(28), W-S(136), S(28));
      g.DrawRectangle(&p, W-S(104), S(22), S(11), S(11));
      g.DrawLine(&p, W-S(66), S(22), W-S(55), S(33));
      g.DrawLine(&p, W-S(55), S(22), W-S(66), S(33)); }

    if(g_lockup){
      float lw = S(196);
      float lh = lw * g_lockup->GetHeight() / g_lockup->GetWidth();
      g.DrawImage(g_lockup, RectF(W - S(56) - lw, S(74), lw, lh));
    }
    DrawOrbitals(g, RectF(S(26), S(118), S(548), S(442)));

    DrawTextAt(g, L"ASSISTANT  /  WINDOWS", RectF(S(56), H - S(122), S(400), S(22)), S(14), kText);
    DrawTextAt(g, L"SETUP  /  2026", RectF(S(56), H - S(96), S(300), S(20)), S(11), kMuted);
    { Pen p(kCyan, S(2)); g.DrawLine(&p, S(56), H - S(140), S(86), H - S(140)); }

    float cx = S(600);
    if(g_page == 0){
      RectF pill(cx, S(120), S(212), S(30));
      StrokeRound(g, pill, S(15), Color(150,22,214,193), S(1));
      DrawTextAt(g, L"01  /  BOAS-VINDAS", RectF(cx+S(14), S(127), S(190), S(20)), S(11), kCyan, FontStyleBold);
      DrawTextAt(g, L"Instalar o CyberSafe Assistant", RectF(cx, S(168), W-cx-S(44), S(60)), S(28), kText, FontStyleBold);
      DrawTextAt(g, L"Este assistente instala o CyberSafe Assistant neste computador.\nOs seus dados, defini\u00e7\u00f5es e quarentena s\u00e3o preservados.",
                 RectF(cx, S(258), W-cx-S(64), S(56)), S(15), Color(235,214,231,234), FontStyleRegular, StringAlignmentNear, true);
      RectF info(cx, S(330), W - cx - S(56), S(62));
      SolidBrush ib(Color(120,6,24,31));
      FillRound(g, info, S(10), ib);
      StrokeRound(g, info, S(10), Color(90,18,59,68), S(1));
      Icon(g, 4, RectF(cx+S(18), S(346), S(18), S(18)), kCyan);
      DrawTextAt(g, L"Vers\u00e3o 0.2.0-rc.1", RectF(cx+S(46), S(348), S(220), S(22)), S(15), kText, FontStyleBold);
      { Pen p(Color(90,18,59,68), S(1)); g.DrawLine(&p, cx+S(296), S(342), cx+S(296), S(380)); }
      Icon(g, 5, RectF(cx+S(316), S(346), S(18), S(18)), kMuted);
      DrawTextAt(g, L"Ainda n\u00e3o instalado", RectF(cx+S(342), S(348), S(212), S(22)), S(13), kMuted);
    } else if(g_page == 1){
      DrawTextAt(g, L"02  /  MODO", RectF(cx, S(120), S(200), S(20)), S(11), kCyan, FontStyleBold);
      DrawTextAt(g, L"Para quem deve ser instalado?", RectF(cx, S(150), W-cx-S(64), S(44)), S(28), kText, FontStyleBold);
      const wchar_t* opts[2] = { L"Apenas para mim", L"Para todos os utilizadores" };
      const wchar_t* sub[2] = { L"Sem privil\u00e9gios de administrador.", L"Requer eleva\u00e7\u00e3o UAC." };
      for(int i = 0; i < 2; i++){
        RectF o(cx, S(222) + i*S(78), W - cx - S(56), S(64));
        bool sel = (i == 0);
        SolidBrush ob(sel ? Color(40,22,214,193) : Color(90,6,24,31));
        FillRound(g, o, S(10), ob);
        StrokeRound(g, o, S(10), sel ? Color(200,22,214,193) : Color(80,18,59,68), S(1.2f));
        { Pen p(sel ? kCyan : kMuted, S(1.6f));
          g.DrawEllipse(&p, o.X+S(18), o.Y+S(22), S(16), S(16));
          if(sel){ SolidBrush b(kCyan); g.FillEllipse(&b, o.X+S(22), o.Y+S(26), S(8), S(8)); } }
        DrawTextAt(g, opts[i], RectF(o.X+S(48), o.Y+S(14), o.Width-S(70), S(24)), S(15), kText, FontStyleBold);
        DrawTextAt(g, sub[i], RectF(o.X+S(48), o.Y+S(36), o.Width-S(70), S(18)), S(12), kMuted);
      }
    } else if(g_page == 2){
      DrawTextAt(g, L"03  /  VERIFICA\u00c7\u00c3O", RectF(cx, S(120), S(220), S(20)), S(11), kCyan, FontStyleBold);
      DrawTextAt(g, L"Onde deve ser instalado?", RectF(cx, S(150), W-cx-S(64), S(44)), S(28), kText, FontStyleBold);
      DrawTextAt(g, L"Pasta de instala\u00e7\u00e3o", RectF(cx, S(212), S(300), S(20)), S(12), kMuted);
      RectF field(cx, S(236), W - cx - S(56), S(46));
      SolidBrush fb(Color(120,6,24,31));
      FillRound(g, field, S(9), fb);
      StrokeRound(g, field, S(9), Color(100,18,59,68), S(1));
      DrawTextAt(g, L"%LOCALAPPDATA%\\Programs\\CyberSafe Assistant", RectF(cx+S(14), S(248), field.Width-S(28), S(22)), S(13), kText);
      const wchar_t* cb[2] = { L"Atalho no ambiente de trabalho", L"Atalho no menu Iniciar" };
      for(int i = 0; i < 2; i++){
        float y = S(294) + i*S(32);
        RectF box(cx, y, S(18), S(18));
        StrokeRound(g, box, S(4), Color(150,22,214,193), S(1.2f));
        Pen p(kCyan, S(2));
        g.DrawLine(&p, cx+S(4), y+S(9), cx+S(8), y+S(13));
        g.DrawLine(&p, cx+S(8), y+S(13), cx+S(14), y+S(5));
        DrawTextAt(g, cb[i], RectF(cx+S(28), y, S(360), S(20)), S(13), kText);
      }
      RectF space(cx, S(366), W - cx - S(56), S(70));
      SolidBrush sb(Color(90,6,24,31));
      FillRound(g, space, S(10), sb);
      StrokeRound(g, space, S(10), Color(80,18,59,68), S(1));
      DrawTextAt(g, L"Espa\u00e7o necess\u00e1rio", RectF(cx+S(16), S(376), S(200), S(18)), S(12), kMuted);
      DrawTextAt(g, L"318 MB", RectF(cx+S(16), S(396), S(200), S(24)), S(15), kText, FontStyleBold);
      DrawTextAt(g, L"Espa\u00e7o dispon\u00edvel", RectF(cx+S(240), S(376), S(200), S(18)), S(12), kMuted);
      DrawTextAt(g, L"64,2 GB", RectF(cx+S(240), S(396), S(200), S(24)), S(15), kText, FontStyleBold);
    } else if(g_page == 3){
      DrawTextAt(g, L"04  /  INSTALA\u00c7\u00c3O", RectF(cx, S(120), S(230), S(20)), S(11), kCyan, FontStyleBold);
      DrawTextAt(g, L"A instalar o CyberSafe Assistant", RectF(cx, S(150), W-cx-S(64), S(44)), S(28), kText, FontStyleBold);
      DrawTextAt(g, L"A copiar os ficheiros da aplica\u00e7\u00e3o. N\u00e3o feche esta janela.", RectF(cx, S(206), W-cx-S(64), S(24)), S(14), kMuted);
      RectF track(cx, S(270), W - cx - S(56), S(8));
      SolidBrush tb(Color(255,12,40,48));
      FillRound(g, track, S(4), tb);
      float pw = track.Width * (g_progress / 100.0f);
      if(pw > 2){
        RectF fill(track.X, track.Y, pw, track.Height);
        LinearGradientBrush gb(PointF(track.X,0), PointF(track.X+track.Width,0), kCyan, kCyanBright);
        FillRound(g, fill, S(4), gb);
      }
      wchar_t pct[16]; swprintf_s(pct, L"%d%%", g_progress);
      DrawTextAt(g, pct, RectF(cx, S(288), S(80), S(20)), S(12), kMuted);
      DrawTextAt(g, L"Extrair application.asar", RectF(cx, S(310), W-cx-S(64), S(20)), S(12), kMuted);
    } else {
      DrawTextAt(g, L"05  /  CONCLU\u00cdDO", RectF(cx, S(120), S(220), S(20)), S(11), Color(255,72,214,160), FontStyleBold);
      DrawTextAt(g, L"Instala\u00e7\u00e3o conclu\u00edda", RectF(cx, S(150), W-cx-S(64), S(44)), S(28), kText, FontStyleBold);
      DrawTextAt(g, L"O CyberSafe Assistant foi instalado neste computador.", RectF(cx, S(206), W-cx-S(64), S(24)), S(14), kMuted);
      float y = S(262);
      RectF box(cx, y, S(18), S(18));
      StrokeRound(g, box, S(4), Color(150,22,214,193), S(1.2f));
      if(g_openApp){
        Pen p(kCyan, S(2));
        g.DrawLine(&p, cx+S(4), y+S(9), cx+S(8), y+S(13));
        g.DrawLine(&p, cx+S(8), y+S(13), cx+S(14), y+S(5));
      }
      DrawTextAt(g, L"Abrir o CyberSafe Assistant", RectF(cx+S(28), y-S(1), S(360), S(22)), S(13), kText);
    }

    for(size_t i = 0; i < g_buttons.size(); i++){
      Btn& b = g_buttons[i];
      RectF r((float)b.r.left, (float)b.r.top, (float)(b.r.right-b.r.left), (float)(b.r.bottom-b.r.top));
      bool hov = ((int)i == g_hover) && b.enabled;
      if(b.primary){
        if(b.enabled){
          Color c1(255,43,232,210), c2(255,26,196,176);
          if(hov){ c1 = Color(255,80,246,225); c2 = Color(255,34,214,192); }
          bool pr = ((int)i == g_press);
          if(pr){ c1 = Color(255,28,186,168); c2 = Color(255,18,158,140); }
          LinearGradientBrush gb(PointF(r.X,r.Y), PointF(r.X,r.GetBottom()), c1, c2);
          FillRound(g, r, S(10), gb);
        } else {
          SolidBrush d(Color(255,16,44,48));
          FillRound(g, r, S(10), d);
        }
        DrawTextAt(g, b.label, RectF(r.X, r.Y + S(16), r.Width, S(26)), S(16),
                   b.enabled ? Color(255,3,33,31) : kMuted, FontStyleBold, StringAlignmentCenter);
        if(b.icon >= 0) Icon(g, b.icon, RectF(r.X + S(28), r.Y + S(18), S(22), S(22)),
                             b.enabled ? Color(255,3,33,31) : kMuted);
      } else {
        SolidBrush gb(Color(hov?150:110,8,27,35));
        FillRound(g, r, S(10), gb);
        StrokeRound(g, r, S(10), b.enabled ? Color(255,26,120,130) : Color(90,18,59,68), S(1.2f));
        DrawTextAt(g, b.label, RectF(r.X + S(46), r.Y + S(17), r.Width - S(60), S(24)), S(15),
                   b.enabled ? kText : Color(150,126,164,168), FontStyleBold);
        if(b.icon >= 0) Icon(g, b.icon, RectF(r.X + S(18), r.Y + S(18), S(22), S(22)),
                             b.enabled ? kText : Color(150,126,164,168));
      }
      if((int)i == g_focus && b.enabled)
        StrokeRound(g, RectF(r.X-S(3), r.Y-S(3), r.Width+S(6), r.Height+S(6)), S(13), Color(180,22,214,193), S(1.6f));
    }
    if(!g_note.empty())
      DrawTextAt(g, g_note.c_str(), RectF(S(56), H - S(52), W - S(120), S(20)), S(11), Color(200,255,190,120));
  }
  BitBlt(hdc, 0, 0, rc.right, rc.bottom, mem, 0, 0, SRCCOPY);
  SelectObject(mem, old);
  DeleteObject(bmp);
  DeleteDC(mem);
}

static void Go(HWND hwnd, int page){
  g_page = page; g_progress = 0; g_hover = -1; g_focus = 0;
  Layout(hwnd);
  InvalidateRect(hwnd, nullptr, FALSE);
  KillTimer(hwnd, 1);
  KillTimer(hwnd, 2);
  if(page == 3) SetTimer(hwnd, 1, 120, nullptr);
}

static void Click(HWND hwnd, int id){
  if(id < 0 || id >= (int)g_buttons.size()) return;
  if(!g_buttons[id].enabled) return;
  int local = g_buttons[id].id;
  if(g_page == 0){
    if(local == 0) Go(hwnd, 1);
    else if(local == 3){ g_note = L"Licen\u00e7as de terceiros s\u00e3o inclu\u00eddas no instalador final."; InvalidateRect(hwnd, nullptr, FALSE); }
  } else if(g_page == 1){
    Go(hwnd, local == 0 ? 0 : 2);
  } else if(g_page == 2){
    Go(hwnd, local == 0 ? 1 : 3);
  } else if(g_page == 3){
    if(local == 0) Go(hwnd, 0);
  } else {
    if(local == 0) DestroyWindow(hwnd);
  }
}

static LRESULT CALLBACK WndProc(HWND hwnd, UINT msg, WPARAM wp, LPARAM lp){
  switch(msg){
    case WM_CREATE:
      Layout(hwnd);
      if(g_anim){ g_last = GetTickCount64(); SetTimer(hwnd, 3, 33, nullptr); }
      return 0;
    case WM_SIZE:
      Layout(hwnd);
      if(g_anim){
        if(IsIconic(hwnd)) KillTimer(hwnd, 3);
        else { g_last = GetTickCount64(); SetTimer(hwnd, 3, 33, nullptr); }
      }
      InvalidateRect(hwnd, nullptr, FALSE);
      return 0;
    case WM_PAINT: {
      PAINTSTRUCT ps; HDC dc = BeginPaint(hwnd, &ps);
      Paint(hwnd, dc);
      EndPaint(hwnd, &ps);
      return 0;
    }
    case WM_MOUSEMOVE: {
      int x = GET_X_LPARAM(lp), y = GET_Y_LPARAM(lp), hit = -1;
      for(size_t i = 0; i < g_buttons.size(); i++){
        RECT r = g_buttons[i].r;
        if(x >= r.left && x < r.right && y >= r.top && y < r.bottom) hit = (int)i;
      }
      if(hit != g_hover){ g_hover = hit; InvalidateRect(hwnd, nullptr, FALSE); }
      TRACKMOUSEEVENT tme = { sizeof(tme), TME_LEAVE, hwnd, 0 };
      TrackMouseEvent(&tme);
      return 0;
    }
    case WM_MOUSELEAVE:
      g_hover = -1;
      InvalidateRect(hwnd, nullptr, FALSE);
      return 0;
    case WM_LBUTTONUP: {
      int x = GET_X_LPARAM(lp), y = GET_Y_LPARAM(lp);
      g_press = -1;
      for(size_t i = 0; i < g_buttons.size(); i++){
        RECT r = g_buttons[i].r;
        if(x >= r.left && x < r.right && y >= r.top && y < r.bottom){
          g_focus = (int)i;
          Click(hwnd, (int)i);
          break;
        }
      }
      return 0;
    }
    case WM_KEYDOWN: {
      if(wp == VK_TAB && !g_buttons.empty()){
        int n = (int)g_buttons.size();
        int step = (GetKeyState(VK_SHIFT) & 0x8000) ? -1 : 1;
        g_focus = (g_focus + step + n) % n;
        InvalidateRect(hwnd, nullptr, FALSE);
        return 0;
      }
      if(wp == VK_RETURN || wp == VK_SPACE){ Click(hwnd, g_focus); return 0; }
      if(wp == VK_ESCAPE){ DestroyWindow(hwnd); return 0; }
      if(wp >= VK_LEFT && wp <= VK_DOWN && !g_buttons.empty()){
        int n = (int)g_buttons.size();
        int d = (wp == VK_LEFT || wp == VK_UP) ? -1 : 1;
        g_focus = (g_focus + d + n) % n;
        InvalidateRect(hwnd, nullptr, FALSE);
        return 0;
      }
      return 0;
    }
    case WM_TIMER:
      if(wp == 1){
        g_progress += 4;
        if(g_progress >= 100){ g_progress = 100; KillTimer(hwnd, 1); SetTimer(hwnd, 2, 500, nullptr); }
        InvalidateRect(hwnd, nullptr, FALSE);
      } else if(wp == 2){
        KillTimer(hwnd, 2);
        Go(hwnd, 4);
      } else if(wp == 3){
        ULONGLONG now = GetTickCount64();
        double dt = (double)(now - g_last) / 1000.0;
        g_last = now;
        if(dt > 0.25) dt = 0.25;
        g_phase += dt;
        InvalidateRect(hwnd, nullptr, FALSE);
      }
      return 0;
    case WM_NCHITTEST: {
      LRESULT r = DefWindowProc(hwnd, msg, wp, lp);
      if(r == HTCLIENT){
        POINT p{ GET_X_LPARAM(lp), GET_Y_LPARAM(lp) };
        ScreenToClient(hwnd, &p);
        if(p.y < (int)S(52)) return HTCAPTION;
      }
      return r;
    }
    case WM_LBUTTONDOWN: {
      int x = GET_X_LPARAM(lp), y = GET_Y_LPARAM(lp);
      RECT rc; GetClientRect(hwnd, &rc);
      if(y < (int)S(52) && x > rc.right - (int)S(120)){ DestroyWindow(hwnd); return 0; }
      for(size_t i = 0; i < g_buttons.size(); i++){
        RECT r = g_buttons[i].r;
        if(g_buttons[i].enabled && x >= r.left && x < r.right && y >= r.top && y < r.bottom){
          g_press = (int)i; InvalidateRect(hwnd, nullptr, FALSE); break;
        }
      }
      break;
    }
    case WM_PRINTCLIENT: {
      Paint(hwnd, (HDC)wp);
      return 0;
    }
    case WM_ERASEBKGND:
      return 1;
    case WM_DESTROY:
      PostQuitMessage(0);
      return 0;
  }
  return DefWindowProc(hwnd, msg, wp, lp);
}

int APIENTRY wWinMain(HINSTANCE hInst, HINSTANCE, LPWSTR, int){
  SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
  BOOL animPref = TRUE;
  SystemParametersInfoW(0x1042, 0, &animPref, 0);
  g_anim = animPref != FALSE;
  GdiplusStartupInput in;
  ULONG_PTR token;
  GdiplusStartup(&token, &in, nullptr);
  LoadImages();

  WNDCLASSEXW wc = { sizeof(wc) };
  wc.style = CS_HREDRAW | CS_VREDRAW;
  wc.lpfnWndProc = WndProc;
  wc.hInstance = hInst;
  wc.hCursor = LoadCursor(nullptr, IDC_ARROW);
  wc.lpszClassName = kClass;
  wc.hIcon = LoadIcon(nullptr, IDI_APPLICATION);
  RegisterClassExW(&wc);

  int w = 1120, h = 720;
  HDC screen = GetDC(nullptr);
  int dpi = GetDeviceCaps(screen, LOGPIXELSX);
  ReleaseDC(nullptr, screen);
  g_dpi = dpi;
  w = MulDiv(w, dpi, 96);
  h = MulDiv(h, dpi, 96);
  int x = (GetSystemMetrics(SM_CXSCREEN) - w) / 2;
  int y = (GetSystemMetrics(SM_CYSCREEN) - h) / 2;
  HWND hwnd = CreateWindowExW(0, kClass, kTitle, WS_POPUP, x, y, w, h, nullptr, nullptr, hInst, nullptr);
  HRGN rgn = CreateRoundRectRgn(0, 0, w+1, h+1, (int)S(18), (int)S(18));
  SetWindowRgn(hwnd, rgn, TRUE);
  ShowWindow(hwnd, SW_SHOW);
  UpdateWindow(hwnd);

  MSG msg;
  while(GetMessage(&msg, nullptr, 0, 0)){ TranslateMessage(&msg); DispatchMessage(&msg); }
  GdiplusShutdown(token);
  return 0;
}
