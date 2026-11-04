// CyberSafe setup presentation layer.
// Original Win32/GDI+ Orbital B drawing; in-process frontend of the NSIS engine.
// No standalone installer process and no timed installation simulation.
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
#include "nsis-plugin.h"

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
static HWND g_licenseEdit = nullptr;
static std::wstring g_notices;
static std::wstring g_note;
static Bitmap *g_core = nullptr;
static double g_phase = 0.0;
static bool g_anim = true;
static ULONGLONG g_last = 0;
static int g_press = -1;
static int g_winHover = -1, g_winPress = -1;
static RECT g_winBtn[3];
static HICON g_appIcon = nullptr;

static float g_ui = 1.0f;
static float S(float v){ return v * g_dpi / 96.0f * g_ui; }

static bool FileExistsW(const std::wstring& p){
  DWORD a = GetFileAttributesW(p.c_str());
  return a != INVALID_FILE_ATTRIBUTES;
}
static std::wstring FindAsset(const wchar_t* rel){
  if(g_backend) {
    const std::wstring full = g_assets + L"/" + rel;
    return FileExistsW(full) ? full : L"";
  }
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
  g_ui = fminf(W / 1120.0f, H / 720.0f);
  if(g_ui < 1.0f) g_ui = 1.0f;
  if(g_ui > 1.9f) g_ui = 1.9f;
  float bx = W * 0.536f, bw = S(232), bh = S(58), gap = S(18), by = H - S(268);
  float wbw = S(46), wbh = S(34), wgap = S(8);
  float wx = W - S(20) - wbw * 3 - wgap * 2;
  for(int i = 0; i < 3; i++){
    g_winBtn[i].left = (LONG)(wx + i * (wbw + wgap));
    g_winBtn[i].right = (LONG)(wx + i * (wbw + wgap) + wbw);
    g_winBtn[i].top = (LONG)S(11);
    g_winBtn[i].bottom = (LONG)(S(11) + wbh);
  }
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
    add(0, L"Instalar", 0, true, g_backend);
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
    Btn c; c.id = 0; c.label = L"Cancelar"; c.icon = -1; c.primary = false; c.enabled = !g_mutating;
    c.r = { (LONG)(W - S(56) - S(200)), (LONG)by, (LONG)(W - S(56)), (LONG)(by+bh) };
    g_buttons.push_back(c);
  } else {
    Btn c; c.id = 0; c.label = L"Concluir"; c.icon = -1; c.primary = true; c.enabled = true;
    if(g_page == 6) c.label = L"Voltar";
    c.r = { (LONG)(W - S(56) - S(200)), (LONG)by, (LONG)(W - S(56)), (LONG)(by+bh) };
    g_buttons.push_back(c);
  }
  if(g_pathEdit) {
    ShowWindow(g_pathEdit, g_page == 2 ? SW_SHOW : SW_HIDE);
    MoveWindow(g_pathEdit,(int)(W * 0.536f + S(14)),(int)S(244),(int)(W-W*0.536f-S(84)),(int)S(30),TRUE);
  }
  if(g_licenseEdit) {
    ShowWindow(g_licenseEdit,g_page==6?SW_SHOW:SW_HIDE);
    MoveWindow(g_licenseEdit,(int)(W*0.536f),(int)S(212),(int)(W-W*0.536f-S(56)),(int)(by-S(232)),TRUE);
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

    if(g_appIcon) DrawIconEx(mem, (int)S(20), (int)S(15), g_appIcon, (int)S(22), (int)S(22), 0, nullptr, DI_NORMAL);
    DrawTextAt(g, kTitle, RectF(S(54), S(18), W - S(260), S(28)), S(15), kText);
    { Pen p(Color(60,18,59,68), S(1)); g.DrawLine(&p, S(28), S(58), W-S(28), S(58)); }
    for(int i = 0; i < 3; i++){
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
    }

    if(g_lockup){
      float lw = S(196);
      float lh = lw * g_lockup->GetHeight() / g_lockup->GetWidth();
      g.DrawImage(g_lockup, RectF(W - S(56) - lw, S(74), lw, lh));
    }
    DrawOrbitals(g, RectF(S(26), (H - S(442)) * 0.5f + S(10), S(548), S(442)));

    DrawTextAt(g, L"ASSISTANT  /  WINDOWS", RectF(S(56), H - S(122), S(400), S(22)), S(14), kText);
    DrawTextAt(g, L"SETUP  /  2026", RectF(S(56), H - S(96), S(300), S(20)), S(11), kMuted);
    { Pen p(kCyan, S(2)); g.DrawLine(&p, S(56), H - S(140), S(86), H - S(140)); }

    float cx = W * 0.536f;
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
      DrawTextAt(g, (L"Vers\u00e3o " + g_version).c_str(), RectF(cx+S(46), S(348), S(220), S(22)), S(15), kText, FontStyleBold);
      { Pen p(Color(90,18,59,68), S(1)); g.DrawLine(&p, cx+S(296), S(342), cx+S(296), S(380)); }
      Icon(g, 5, RectF(cx+S(316), S(346), S(18), S(18)), kMuted);
      DrawTextAt(g, g_installed.empty()?L"N\u00e3o detetado":g_installed.c_str(), RectF(cx+S(342), S(348), S(212), S(22)), S(13), kMuted);
    } else if(g_page == 1){
      DrawTextAt(g, L"02  /  MODO", RectF(cx, S(120), S(200), S(20)), S(11), kCyan, FontStyleBold);
      DrawTextAt(g, L"Para quem deve ser instalado?", RectF(cx, S(150), W-cx-S(64), S(44)), S(28), kText, FontStyleBold);
      const wchar_t* opts[2] = { L"Apenas para mim", L"Para todos os utilizadores" };
      const wchar_t* sub[2] = { L"Sem privil\u00e9gios de administrador.", L"Indispon\u00edvel neste percurso. Sem eleva\u00e7\u00e3o autom\u00e1tica." };
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
      // Real editable destination is a dark native EDIT inside this original card.
      const wchar_t* cb[2] = { L"Atalho no ambiente de trabalho", L"Atalho no menu Iniciar" };
      for(int i = 0; i < 2; i++){
        float y = S(294) + i*S(32);
        RectF box(cx, y, S(18), S(18));
        StrokeRound(g, box, S(4), Color(150,22,214,193), S(1.2f));
        if(g_shortcuts[i]) {
          Pen p(kCyan, S(2));
          g.DrawLine(&p, cx+S(4), y+S(9), cx+S(8), y+S(13));
          g.DrawLine(&p, cx+S(8), y+S(13), cx+S(14), y+S(5));
        }
        DrawTextAt(g, cb[i], RectF(cx+S(28), y, S(360), S(20)), S(13), kText);
      }
      RectF space(cx, S(366), W - cx - S(56), S(70));
      SolidBrush sb(Color(90,6,24,31));
      FillRound(g, space, S(10), sb);
      StrokeRound(g, space, S(10), Color(80,18,59,68), S(1));
      DrawTextAt(g, L"Tamanho do payload", RectF(cx+S(16), S(376), S(200), S(18)), S(12), kMuted);
      DrawTextAt(g, (g_required + L" KB (payload)").c_str(), RectF(cx+S(16), S(396), S(200), S(24)), S(15), kText, FontStyleBold);
      DrawTextAt(g, L"Espa\u00e7o dispon\u00edvel", RectF(cx+S(240), S(376), S(200), S(18)), S(12), kMuted);
      ULARGE_INTEGER freeBytes{};
      std::wstring probe=g_destination;
      while(!probe.empty() && !FileExistsW(probe)) { const auto cut=probe.find_last_of(L'\\'); if(cut==std::wstring::npos) break; probe.resize(cut); }
      if(probe.size()==2) probe+=L"\\";
      const std::wstring freeText=GetDiskFreeSpaceExW(probe.c_str(),&freeBytes,nullptr,nullptr)?std::to_wstring(freeBytes.QuadPart/(1024*1024))+L" MB":L"N\u00e3o verificado";
      DrawTextAt(g, freeText.c_str(), RectF(cx+S(240), S(396), S(200), S(24)), S(15), kText, FontStyleBold);
    } else if(g_page == 3){
      DrawTextAt(g, L"04  /  INSTALA\u00c7\u00c3O", RectF(cx, S(120), S(230), S(20)), S(11), kCyan, FontStyleBold);
      DrawTextAt(g, L"A instalar o CyberSafe Assistant", RectF(cx, S(150), W-cx-S(64), S(44)), S(28), kText, FontStyleBold);
      DrawTextAt(g, g_status.c_str(), RectF(cx, S(206), W-cx-S(64), S(58)), S(14), kMuted, FontStyleRegular, StringAlignmentNear, true);
      RectF track(cx, S(270), W - cx - S(56), S(8));
      SolidBrush tb(Color(255,12,40,48));
      FillRound(g, track, S(4), tb);
      float pw = track.Width * 0.2f;
      if(pw > 2){
        // Indeterminate indicator only. Orbit animation does not measure extraction.
        RectF fill(track.X + (track.Width-pw)*(0.5f+0.5f*sinf((float)g_phase*2)), track.Y, pw, track.Height);
        LinearGradientBrush gb(PointF(track.X,0), PointF(track.X+track.Width,0), kCyan, kCyanBright);
        FillRound(g, fill, S(4), gb);
      }
      DrawTextAt(g, L"Progresso indeterminado — fase real do NSIS", RectF(cx, S(288), W-cx-S(64), S(26)), S(12), kMuted);
      DrawTextAt(g, g_mutating?L"Cancelamento indispon\u00edvel nesta fase cr\u00edtica. N\u00e3o force o encerramento.":L"Pode cancelar antes de o NSIS alterar o destino.", RectF(cx, S(326), W-cx-S(64), S(62)), S(13), kMuted, FontStyleRegular, StringAlignmentNear, true);
    } else if(g_page==6) {
      DrawTextAt(g,L"LICEN\u00c7AS E AVISOS",RectF(cx,S(120),W-cx-S(64),S(28)),S(16),kCyan,FontStyleBold);
      DrawTextAt(g,L"Avisos reais inclu\u00eddos no Setup. Sem EULA adicional definida.",RectF(cx,S(158),W-cx-S(64),S(42)),S(13),kMuted,FontStyleRegular,StringAlignmentNear,true);
    } else {
      DrawTextAt(g, g_success?L"05  /  CONCLU\u00cdDO":L"05  /  N\u00c3O CONCLU\u00cdDO", RectF(cx, S(120), S(220), S(20)), S(11), g_success?Color(255,72,214,160):Color(255,255,160,130), FontStyleBold);
      DrawTextAt(g, g_success?L"Instala\u00e7\u00e3o conclu\u00edda":L"Instala\u00e7\u00e3o n\u00e3o conclu\u00edda", RectF(cx, S(150), W-cx-S(64), S(44)), S(28), kText, FontStyleBold);
      DrawTextAt(g, g_status.c_str(), RectF(cx, S(206), W-cx-S(64), S(76)), S(14), kMuted, FontStyleRegular, StringAlignmentNear, true);
      /* No launch checkbox: this path does not yet implement user-context launch. */
      if(g_success) DrawTextAt(g,L"Pode abrir a aplica\u00e7\u00e3o pelo menu Iniciar ou pela pasta escolhida.",RectF(cx,S(310),W-cx-S(64),S(54)),S(13),kMuted,FontStyleRegular,StringAlignmentNear,true);
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
  g_page = page; g_hover = -1; g_focus = 0;
  Layout(hwnd);
  InvalidateRect(hwnd, nullptr, FALSE);
  // No installation timers. NSIS alone signals phase/result.
}

static void Click(HWND hwnd, int id){
  if(id < 0 || id >= (int)g_buttons.size()) return;
  if(!g_buttons[id].enabled) return;
  int local = g_buttons[id].id;
  if(g_page == 0){
    if(local == 0) Go(hwnd, 1);
    else if(local == 3) Go(hwnd,6);
  } else if(g_page == 1){
    Go(hwnd, local == 0 ? 0 : 2);
  } else if(g_page == 2){
    if(local==0) { Go(hwnd,1); return; }
    wchar_t path[512]; GetWindowTextW(g_pathEdit,path,512); g_destination=path;
    if(!ValidDestination(g_destination)) { g_note=L"Destino inv\u00e1lido: escolha uma pasta local absoluta, sem liga\u00e7\u00f5es ou caminhos de sistema."; InvalidateRect(hwnd,nullptr,FALSE); return; }
    g_note=L""; g_action=1; Go(hwnd,3); SetEvent(g_decisionEvent);
  } else if(g_page == 3){
    if(local == 0 && !g_mutating) { g_action=0; DestroyWindow(hwnd); }
  } else {
    if(local == 0) { if(g_page==6) Go(hwnd,0); else DestroyWindow(hwnd); }
  }
}

static LRESULT CALLBACK WndProc(HWND hwnd, UINT msg, WPARAM wp, LPARAM lp){
  switch(msg){
    case WM_CREATE:
      g_pathEdit=CreateWindowExW(0,L"EDIT",g_destination.c_str(),WS_CHILD|ES_AUTOHSCROLL|WS_TABSTOP,0,0,0,0,hwnd,(HMENU)100,g_module,nullptr);
      g_editFont=CreateFontW(-16,0,0,0,FW_NORMAL,FALSE,FALSE,FALSE,DEFAULT_CHARSET,0,0,CLEARTYPE_QUALITY,0,L"Segoe UI");
      SendMessageW(g_pathEdit,WM_SETFONT,(WPARAM)g_editFont,TRUE);
      SendMessageW(g_pathEdit,EM_SETLIMITTEXT,220,0);
      g_licenseEdit=CreateWindowExW(0,L"EDIT",g_notices.c_str(),WS_CHILD|WS_VSCROLL|ES_MULTILINE|ES_READONLY,0,0,0,0,hwnd,(HMENU)101,g_module,nullptr);
      SendMessageW(g_licenseEdit,WM_SETFONT,(WPARAM)g_editFont,TRUE);
      g_note=L"Reparar e Desinstalar: indispon\u00edveis neste percurso. Use o desinstalador instalado nas Defini\u00e7\u00f5es do Windows.";
      Layout(hwnd);
      if(g_anim){ g_last = GetTickCount64(); SetTimer(hwnd, 3, 33, nullptr); }
      return 0;
    case WM_SIZE:
      Layout(hwnd);
      if(IsZoomed(hwnd) || IsIconic(hwnd)) SetWindowRgn(hwnd, nullptr, TRUE);
      else {
        RECT wr; GetClientRect(hwnd, &wr);
        SetWindowRgn(hwnd, CreateRoundRectRgn(0, 0, wr.right + 1, wr.bottom + 1, (int)S(16), (int)S(16)), TRUE);
      }
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
      int x = GET_X_LPARAM(lp), y = GET_Y_LPARAM(lp), hit = -1, wh = -1;
      for(int i = 0; i < 3; i++){
        if(x >= g_winBtn[i].left && x < g_winBtn[i].right && y >= g_winBtn[i].top && y < g_winBtn[i].bottom) wh = i;
      }
      if(wh != g_winHover){ g_winHover = wh; InvalidateRect(hwnd, nullptr, FALSE); }
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
      if(g_winPress >= 0){
        int w = g_winPress; g_winPress = -1;
        bool inside = x >= g_winBtn[w].left && x < g_winBtn[w].right && y >= g_winBtn[w].top && y < g_winBtn[w].bottom;
        InvalidateRect(hwnd, nullptr, FALSE);
        if(inside){
          if(w == 0) ShowWindow(hwnd, SW_MINIMIZE);
          else if(w == 1) ShowWindow(hwnd, IsZoomed(hwnd) ? SW_RESTORE : SW_MAXIMIZE);
          else SendMessageW(hwnd,WM_CLOSE,0,0);
        }
        return 0;
      }
      if(g_page==2) {
        RECT client; GetClientRect(hwnd,&client);
        if(x>=client.right*0.536f && x<client.right-S(56)) for(int i=0;i<2;i++) {
          if(y>=S(294+i*32) && y<S(318+i*32)) { g_shortcuts[i]=!g_shortcuts[i]; InvalidateRect(hwnd,nullptr,FALSE); return 0; }
        }
      }
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
      if(wp == VK_ESCAPE){ SendMessageW(hwnd,WM_CLOSE,0,0); return 0; }
      if(g_page==2 && (wp=='D'||wp=='M')) { g_shortcuts[wp=='D'?0:1]=!g_shortcuts[wp=='D'?0:1]; InvalidateRect(hwnd,nullptr,FALSE); return 0; }
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
      if(wp == 3){
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
        if(p.y < (int)S(52)){
          for(int i = 0; i < 3; i++){
            if(p.x >= g_winBtn[i].left && p.x < g_winBtn[i].right &&
               p.y >= g_winBtn[i].top && p.y < g_winBtn[i].bottom) return HTCLIENT;
          }
          return HTCAPTION;
        }
      }
      return r;
    }
    case WM_LBUTTONDOWN: {
      int x = GET_X_LPARAM(lp), y = GET_Y_LPARAM(lp);
      for(int i = 0; i < 3; i++){
        if(x >= g_winBtn[i].left && x < g_winBtn[i].right && y >= g_winBtn[i].top && y < g_winBtn[i].bottom){
          g_winPress = i; InvalidateRect(hwnd, nullptr, FALSE); return 0;
        }
      }
      for(size_t i = 0; i < g_buttons.size(); i++){
        RECT r = g_buttons[i].r;
        if(g_buttons[i].enabled && x >= r.left && x < r.right && y >= r.top && y < r.bottom){
          g_press = (int)i; InvalidateRect(hwnd, nullptr, FALSE); break;
        }
      }
      break;
    }
    case WM_GETMINMAXINFO: {
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
    case WM_COMMAND:
      if(LOWORD(wp)==100 && HIWORD(wp)==EN_CHANGE && g_page==2) {
        wchar_t text[512]; GetWindowTextW(g_pathEdit,text,512);
        g_destination=text;
        InvalidateRect(hwnd,nullptr,FALSE);
      }
      return 0;
    case WM_CTLCOLOREDIT:
    case WM_CTLCOLORSTATIC:
      SetTextColor((HDC)wp,RGB(237,248,248)); SetBkColor((HDC)wp,RGB(6,24,31));
      { static HBRUSH brush=CreateSolidBrush(RGB(6,24,31)); return (LRESULT)brush; }
    case WM_ORBITAL_PHASE:
      if(wp==1) {
        if(g_action!=1) return FALSE;
        g_mutating=true; g_note=L"";
      }
      g_status=(const wchar_t*)lp; Layout(hwnd); InvalidateRect(hwnd,nullptr,FALSE); return TRUE;
    case WM_ORBITAL_RESULT:
      g_mutating=false; g_resultShown=true; g_success=wp!=0; g_status=(const wchar_t*)lp;
      Go(hwnd,4); return 0;
    case WM_ORBITAL_FALLBACK:
      if(g_mutating && !g_resultShown) {
        g_mutating=false; g_resultShown=true; g_success=false;
        g_status=L"O motor terminou sem confirmar a instala\u00e7\u00e3o. Podem existir ficheiros parciais; o resultado n\u00e3o foi aprovado.";
        Go(hwnd,4); return TRUE;
      }
      return FALSE;
    case WM_ORBITAL_STOP:
      DestroyWindow(hwnd); return 0;
    case WM_CLOSE:
      if(g_mutating) { g_note=L"O NSIS est\u00e1 numa fase cr\u00edtica. Aguarde; n\u00e3o se for\u00e7a a termina\u00e7\u00e3o."; InvalidateRect(hwnd,nullptr,FALSE); return 0; }
      if(!g_resultShown) g_action=0;
      DestroyWindow(hwnd);
      return 0;
    case WM_NCLBUTTONDBLCLK:
      if(wp == HTCAPTION) ShowWindow(hwnd, IsZoomed(hwnd) ? SW_RESTORE : SW_MAXIMIZE);
      return 0;
    case WM_PRINTCLIENT: {
      Paint(hwnd, (HDC)wp);
      return 0;
    }
    case WM_ERASEBKGND:
      return 1;
    case WM_DESTROY:
      g_window=nullptr;
      SetEvent(g_decisionEvent);
      PostQuitMessage(0);
      return 0;
  }
  return DefWindowProc(hwnd, msg, wp, lp);
}

static DWORD WINAPI RunOrbital(void*) {
  const HINSTANCE hInst=g_module;
  SetThreadDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
  // Read the actual bundled notice document, never launch a PATH-resolved tool.
  std::ifstream input(g_assets+L"/THIRD-PARTY-NOTICES.txt",std::ios::binary);
  const std::string bytes((std::istreambuf_iterator<char>(input)),{});
  const int chars=MultiByteToWideChar(CP_UTF8,MB_ERR_INVALID_CHARS,bytes.data(),(int)bytes.size(),nullptr,0);
  if(chars>0) { g_notices.resize(chars); MultiByteToWideChar(CP_UTF8,MB_ERR_INVALID_CHARS,bytes.data(),(int)bytes.size(),g_notices.data(),chars); }
  else g_notices=L"N\u00e3o foi poss\u00edvel ler os avisos de licen\u00e7a.";
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
  std::wstring icoPath = FindAsset(L"assets/branding/icon/cybersafe.ico");
  if(!icoPath.empty()) g_appIcon = (HICON)LoadImageW(nullptr, icoPath.c_str(), IMAGE_ICON, 0, 0, LR_LOADFROMFILE | LR_DEFAULTSIZE);
  HWND hwnd = CreateWindowExW(WS_EX_APPWINDOW, kClass, kTitle, WS_POPUP, x, y, w, h, nullptr, nullptr, hInst, nullptr);
  if(!hwnd) { g_action=2; SetEvent(g_decisionEvent); return 1; }
  g_window=hwnd;
  if(g_appIcon){
    SendMessageW(hwnd, WM_SETICON, ICON_BIG, (LPARAM)g_appIcon);
    SendMessageW(hwnd, WM_SETICON, ICON_SMALL, (LPARAM)g_appIcon);
  }
  HRGN rgn = CreateRoundRectRgn(0, 0, w+1, h+1, (int)S(18), (int)S(18));
  SetWindowRgn(hwnd, rgn, TRUE);
  ShowWindow(hwnd, SW_SHOW);
  UpdateWindow(hwnd);

  MSG msg;
  while(GetMessage(&msg, nullptr, 0, 0)){ TranslateMessage(&msg); DispatchMessage(&msg); }
  delete g_core; delete g_sceneSoft; delete g_scene; delete g_lockup; delete g_symbol;
  if(g_appIcon) DestroyIcon(g_appIcon);
  if(g_editFont) DeleteObject(g_editFont);
  UnregisterClassW(kClass,hInst);
  GdiplusShutdown(token);
  return 0;
}
