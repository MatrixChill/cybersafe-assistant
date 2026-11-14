// CyberSafe Security Center — implementação de REFERÊNCIA (C++20, Xlib, Xft).
//
// Independente do código do Nigor. Pontos de adaptação explícitos:
//   · Theme       → substituir `nigorTheme()` pelos tokens de src/ui/appearance.h;
//   · Launcher    → `Client::openApp()` (ou o lançador da sessão Nigor);
//   · Notificador → `NotificationSink` (interface vazia: o Nigor ainda não tem
//                   notificações; nada é simulado).
// Dados SÓ do adaptador `cybersafe/nigor.hpp`. Sem endpoints novos.
//
// Uso: cybersafe-security-center [--self-test] [--status-binary /caminho]
#include <cybersafe/nigor.hpp>

#include <X11/Xlib.h>
#include <X11/Xutil.h>
#include <X11/keysym.h>
#include <X11/Xft/Xft.h>
// Xlib define `Status` como macro (int); colide com cybersafe::Status.
#undef Status

#include <ctime>
#include <fstream>
#include <iostream>
#include <zlib.h>
#include <sys/select.h>

using namespace cybersafe;

// ───────────── Pontos de adaptação ─────────────
struct Theme {
  const char* bg = "#0e1520";
  const char* surface = "#162131";
  const char* surfaceHi = "#1f2d42";
  const char* fg = "#e6edf5";
  const char* muted = "#8a9ab0";
  const char* accent = "#5ce6ed";
  const char* ok = "#77dbb0";
  const char* warn = "#eac17c";
  const char* crit = "#ff9caa";
  const char* font = "sans-serif:size=10";
  const char* fontBold = "sans-serif:size=11:weight=bold";
  const char* fontTitle = "sans-serif:size=14:weight=bold";
};
/// Substituir pelo mapeamento de src/ui/appearance.h do Nigor.
Theme nigorTheme() { return Theme{}; }

/// Interface para futuras notificações do Nigor. Não faz nada até existir um sistema real.
struct NotificationSink {
  virtual ~NotificationSink() = default;
  virtual void securityStateChanged(const Status&) {}
};

// ───────────── Janela ─────────────
enum class Tab { Overview, Scanner, Engines, History, Updates, Settings };
static const std::pair<Tab, const char*> kTabs[] = {
  {Tab::Overview, "Visão geral"}, {Tab::Scanner, "Scanner"}, {Tab::Engines, "Motores"},
  {Tab::History, "Histórico e alertas"}, {Tab::Updates, "Atualizações"}, {Tab::Settings, "Definições"},
};

struct Button { int x, y, w, h; std::string id; };

class SecurityCenter {
 public:
  SecurityCenter(Client client, Theme theme, NotificationSink& sink)
      : client_(std::move(client)), theme_(theme), sink_(sink) {
    if (pipe2(wake_, O_CLOEXEC | O_NONBLOCK) != 0) wake_[0] = wake_[1] = -1;
    poller_ = std::make_unique<AsyncPoller>(client_, std::chrono::seconds(10), [this] { wake(); });
  }
  ~SecurityCenter() {
    poller_.reset();
    for (auto& t : workers_) if (t.joinable()) t.join();
    if (dpy_) {
      for (auto* f : {font_, bold_, title_}) if (f) XftFontClose(dpy_, f);
      if (draw_) XftDrawDestroy(draw_);
      XCloseDisplay(dpy_);
    }
  }

  bool open() {
    dpy_ = XOpenDisplay(nullptr);
    if (!dpy_) { std::cerr << "Sem sessão X11 (DISPLAY).\n"; return false; }
    int scr = DefaultScreen(dpy_);
    vis_ = DefaultVisual(dpy_, scr);
    cmap_ = DefaultColormap(dpy_, scr);
    win_ = XCreateSimpleWindow(dpy_, RootWindow(dpy_, scr), 0, 0, w_, h_, 0, 0, 0);
    XStoreName(dpy_, win_, "CyberSafe Security Center");
    XClassHint hint{const_cast<char*>("cybersafe-security-center"), const_cast<char*>("CyberSafe")};
    XSetClassHint(dpy_, win_, &hint);
    XSelectInput(dpy_, win_, ExposureMask | ButtonPressMask | KeyPressMask | StructureNotifyMask);
    wmDelete_ = XInternAtom(dpy_, "WM_DELETE_WINDOW", False);
    XSetWMProtocols(dpy_, win_, &wmDelete_, 1);
    font_ = XftFontOpenName(dpy_, scr, theme_.font);
    bold_ = XftFontOpenName(dpy_, scr, theme_.fontBold);
    title_ = XftFontOpenName(dpy_, scr, theme_.fontTitle);
    if (!font_ || !bold_ || !title_) { std::cerr << "Fontes Xft indisponíveis.\n"; return false; }
    draw_ = XftDrawCreate(dpy_, win_, vis_, cmap_);
    XMapWindow(dpy_, win_);
    poller_->start();
    return true;
  }

  /// Ciclo de eventos: X11 + pipe de despertar do poller/trabalhadores. Nunca bloqueia em I/O do CyberSafe.
  /// Captura a janela para PNG (só para provas de teste; nenhum dado sai da máquina).
  bool screenshot(const std::string& file) {
    XWindowAttributes wa; XGetWindowAttributes(dpy_, win_, &wa);
    XImage* img = XGetImage(dpy_, win_, 0, 0, wa.width, wa.height, AllPlanes, ZPixmap);
    if (!img) return false;
    std::string raw;
    for (int y = 0; y < wa.height; ++y) {
      raw += '\0';
      for (int x = 0; x < wa.width; ++x) {
        unsigned long px = XGetPixel(img, x, y);
        raw += char((px >> 16) & 0xff); raw += char((px >> 8) & 0xff); raw += char(px & 0xff);
      }
    }
    XDestroyImage(img);
    uLongf len = compressBound(raw.size()); std::string z(len, '\0');
    if (compress2(reinterpret_cast<Bytef*>(z.data()), &len, reinterpret_cast<const Bytef*>(raw.data()), raw.size(), 9) != Z_OK) return false;
    z.resize(len);
    auto be = [](uint32_t v) { std::string b(4, '\0'); b[0] = char(v >> 24); b[1] = char(v >> 16); b[2] = char(v >> 8); b[3] = char(v); return b; };
    auto chunk = [&](const char* type, const std::string& data) {
      std::string td = std::string(type, 4) + data;
      return be(static_cast<uint32_t>(data.size())) + td + be(static_cast<uint32_t>(crc32(0, reinterpret_cast<const Bytef*>(td.data()), td.size())));
    };
    std::string ihdr = be(wa.width) + be(wa.height) + std::string("\x08\x02\x00\x00\x00", 5);
    std::ofstream out(file, std::ios::binary);
    out << std::string("\x89PNG\r\n\x1a\n", 8) << chunk("IHDR", ihdr) << chunk("IDAT", z) << chunk("IEND", "");
    return static_cast<bool>(out);
  }
  std::string shotPrefix;

  int run(bool selfTest) {
    int xfd = ConnectionNumber(dpy_);
    int frames = 0;
    while (!quit_) {
      while (XPending(dpy_)) { XEvent e; XNextEvent(dpy_, &e); handle(e); }
      redraw();
      if (selfTest) {
        auto snap = poller_->latest();
        if (snap) {  // percorre todos os separadores uma vez e termina
          tab_ = kTabs[frames % 6].first;
          redraw();
          XSync(dpy_, False);
          if (!shotPrefix.empty()) screenshot(shotPrefix + std::to_string(frames) + ".png");
          if (++frames >= 6) { std::cout << "self-test: " << (snap->ok() ? "estado lido" : "erro: " + snap->error.message) << "\n"; return 0; }
          continue;
        }
      }
      fd_set fds; FD_ZERO(&fds); FD_SET(xfd, &fds);
      if (wake_[0] >= 0) FD_SET(wake_[0], &fds);
      timeval tv{1, 0};
      select(std::max(xfd, wake_[0]) + 1, &fds, nullptr, nullptr, &tv);
      if (wake_[0] >= 0 && FD_ISSET(wake_[0], &fds)) { char b[64]; while (read(wake_[0], b, sizeof b) > 0) {} onWake(); }
    }
    return 0;
  }

 private:
  // ── estado ──
  Client client_;
  Theme theme_;
  NotificationSink& sink_;
  std::unique_ptr<AsyncPoller> poller_;
  std::vector<std::thread> workers_;
  int wake_[2]{-1, -1};
  Display* dpy_ = nullptr; Visual* vis_ = nullptr; Colormap cmap_{}; Window win_{}; Atom wmDelete_{};
  XftDraw* draw_ = nullptr; XftFont *font_ = nullptr, *bold_ = nullptr, *title_ = nullptr;
  int w_ = 860, h_ = 560;
  Tab tab_ = Tab::Overview;
  bool quit_ = false;
  std::vector<Button> buttons_;
  // scanner
  std::string path_;
  bool confirming_ = false;
  std::mutex jobM_;
  std::string jobMessage_;
  std::optional<std::string> scanId_;
  // atualizações
  std::optional<Result<UpdateStatus>> update_;
  bool updateBusy_ = false;

  void wake() { if (wake_[1] >= 0) { char c = 1; if (write(wake_[1], &c, 1) < 0) {} } }
  void onWake() {
    auto snap = poller_->latest();
    if (snap && snap->ok()) sink_.securityStateChanged(*snap->value);
  }
  template <class F> void background(F f) { workers_.emplace_back([this, f] { f(); wake(); }); }

  // ── desenho ──
  XftColor color(const char* hex) {
    XftColor c; XftColorAllocName(dpy_, vis_, cmap_, hex, &c); return c;
  }
  void rect(int x, int y, int w, int h, const char* hex) {
    XftColor c = color(hex); XftDrawRect(draw_, &c, x, y, w, h); XftColorFree(dpy_, vis_, cmap_, &c);
  }
  void text(int x, int y, const std::string& s, const char* hex, XftFont* f = nullptr) {
    XftColor c = color(hex);
    XftDrawStringUtf8(draw_, &c, f ? f : font_, x, y, reinterpret_cast<const FcChar8*>(s.data()), static_cast<int>(s.size()));
    XftColorFree(dpy_, vis_, cmap_, &c);
  }
  int button(int x, int y, const std::string& label, const std::string& id, bool enabled = true) {
    XGlyphInfo g; XftTextExtentsUtf8(dpy_, font_, reinterpret_cast<const FcChar8*>(label.data()), static_cast<int>(label.size()), &g);
    int w = g.xOff + 24, h = 28;
    rect(x, y, w, h, enabled ? theme_.surfaceHi : theme_.surface);
    rect(x, y + h - 2, w, 2, enabled ? theme_.accent : theme_.muted);
    text(x + 12, y + 19, label, enabled ? theme_.fg : theme_.muted);
    if (enabled) buttons_.push_back({x, y, w, h, id});
    return w;
  }
  const char* stateColor(EngineState s) {
    return s == EngineState::Active ? theme_.ok : s == EngineState::Degraded || s == EngineState::Unavailable ? theme_.warn
         : s == EngineState::Error ? theme_.crit : theme_.muted;
  }

  void redraw() {
    buttons_.clear();
    rect(0, 0, w_, h_, theme_.bg);
    rect(0, 0, 200, h_, theme_.surface);
    text(20, 36, "CyberSafe", theme_.accent, title_);
    text(20, 56, "Security Center", theme_.muted);
    int y = 90;
    for (auto& [t, label] : kTabs) {
      if (t == tab_) rect(0, y - 4, 200, 34, theme_.surfaceHi), rect(0, y - 4, 3, 34, theme_.accent);
      text(20, y + 17, label, t == tab_ ? theme_.fg : theme_.muted);
      buttons_.push_back({0, y - 4, 200, 34, std::string("tab:") + label});
      y += 38;
    }
    auto snap = poller_->latest();
    int x0 = 224;
    if (!snap) { text(x0, 40, "A consultar o CyberSafe…", theme_.muted, bold_); XFlush(dpy_); return; }
    switch (tab_) {
      case Tab::Overview: drawOverview(x0, *snap); break;
      case Tab::Scanner: drawScanner(x0, *snap); break;
      case Tab::Engines: drawEngines(x0, *snap); break;
      case Tab::History: drawHistory(x0, *snap); break;
      case Tab::Updates: drawUpdates(x0); break;
      case Tab::Settings: drawSettings(x0); break;
    }
    XFlush(dpy_);
  }

  bool offline(int x0, const Result<Status>& s) {
    if (s.ok()) return false;
    text(x0, 40, "Serviço CyberSafe indisponível", theme_.warn, title_);
    text(x0, 70, s.error.message, theme_.muted);
    text(x0, 92, "O estado é desconhecido — não se assume proteção.", theme_.muted);
    button(x0, 116, "Atualizar", "refresh");
    button(x0 + 110, 116, "Abrir CyberSafe", "open");
    return true;
  }

  void drawOverview(int x0, const Result<Status>& r) {
    if (offline(x0, r)) return;
    const Status& s = *r.value;
    bool full = fullyProtected(s);
    text(x0, 40, full ? "Protegido" : toText(s.protection), full ? theme_.ok : s.protection == ProtectionStatus::Critical ? theme_.crit : theme_.warn, title_);
    if (!full) text(x0, 62, "Proteção completa só com serviço, monitorização e os quatro motores ativos.", theme_.muted);
    std::string svc = s.serviceRunning == true ? "Ativo" : s.serviceRunning == false ? "Parado" : "Desconhecido";
    std::string mon = s.monitoringEnabled == true ? "Ligada" : s.monitoringEnabled == false ? "Desligada" : "Desconhecida";
    text(x0, 96, "Serviço: " + svc, theme_.fg); text(x0 + 220, 96, "Monitorização: " + mon, theme_.fg);
    int y = 130;
    const std::pair<const char*, const Engine*> engines[] = {{"ClamAV", &s.engines.clamav}, {"YARA", &s.engines.yara}, {"HashDB", &s.engines.hashDb}, {"Motor C++", &s.engines.native}};
    for (auto& [name, e] : engines) {
      rect(x0, y, 140, 50, theme_.surface);
      text(x0 + 10, y + 20, name, theme_.muted);
      text(x0 + 10, y + 40, engineText(*e), stateColor(e->state), bold_);
      x0 += 150;
    }
    x0 = 224; y = 210;
    text(x0, y, "Última análise", theme_.fg, bold_);
    text(x0, y + 22, s.latestScan ? scanText(*s.latestScan) : "Sem análises registadas", s.latestScan && s.latestScan->clean() ? theme_.ok : theme_.muted);
    text(x0, y + 60, "Alertas recentes: " + std::to_string(s.alerts.size()) + (s.alertsScope == "service-session" ? " (desde o arranque do serviço)" : ""), theme_.fg, bold_);
    auto metric = [](std::optional<double> v) { return v ? std::to_string(static_cast<int>(*v)) + "%" : std::string("—"); };
    text(x0, y + 96, "CPU " + metric(s.cpuPercent) + "   RAM " + metric(s.ramPercent), theme_.muted);
    button(x0, h_ - 56, "Atualizar", "refresh");
    button(x0 + 110, h_ - 56, "Abrir CyberSafe", "open");
  }

  void drawScanner(int x0, const Result<Status>& r) {
    text(x0, 40, "Scanner", theme_.fg, title_);
    text(x0, 66, "Escreva um caminho absoluto ou use Selecionar. A análise corre no serviço CyberSafe.", theme_.muted);
    rect(x0, 84, 460, 30, theme_.surface);
    text(x0 + 8, 104, path_.empty() ? "/caminho/absoluto" : path_, path_.empty() ? theme_.muted : theme_.fg);
    if (access("/usr/bin/zenity", X_OK) == 0) button(x0 + 470, 84, "Selecionar…", "pick");
    int y = 130;
    if (confirming_) {
      rect(x0, y, 600, 74, theme_.surfaceHi);
      text(x0 + 12, y + 22, "Confirmar análise de:", theme_.warn, bold_);
      text(x0 + 12, y + 44, path_, theme_.fg);
      button(x0 + 12, y + 54, "Confirmar", "confirm");
      button(x0 + 120, y + 54, "Cancelar", "unconfirm");
      y += 100;
    } else {
      button(x0, y, "Iniciar análise", "scan", !path_.empty() && path_[0] == '/');
      if (scanId_) button(x0 + 140, y, "Cancelar análise", "cancel");
      y += 50;
    }
    { std::lock_guard l(jobM_); if (!jobMessage_.empty()) text(x0, y, jobMessage_, theme_.fg); }
    if (r.ok() && r.value->latestScan) text(x0, y + 26, "Última análise no histórico: " + scanText(*r.value->latestScan), theme_.muted);
    text(x0, y + 52, "Pedido aceite não é análise concluída; o resultado aparece no histórico.", theme_.muted);
  }

  void drawEngines(int x0, const Result<Status>& r) {
    if (offline(x0, r)) return;
    text(x0, 40, "Motores", theme_.fg, title_);
    const Status& s = *r.value;
    const std::pair<const char*, const Engine*> engines[] = {{"ClamAV", &s.engines.clamav}, {"YARA", &s.engines.yara}, {"HashDB", &s.engines.hashDb}, {"Motor C++", &s.engines.native}};
    int y = 70;
    for (auto& [name, e] : engines) {
      rect(x0, y, 600, 54, theme_.surface);
      text(x0 + 12, y + 22, name, theme_.fg, bold_);
      text(x0 + 160, y + 22, engineText(*e), stateColor(e->state), bold_);
      const char* hint = e->reason == EngineReason::NotInstalled ? "Instale o pacote do motor (ver cybersafe-linux-diagnose)."
                       : e->reason == EngineReason::NoDefinitions ? "Faltam bases de assinaturas (freshclam)."
                       : e->state == EngineState::Error ? "Falha reportada pelo serviço; veja os detalhes no CyberSafe."
                       : e->state == EngineState::Unknown ? "Sem leitura deste motor." : "";
      text(x0 + 12, y + 44, hint, theme_.muted);
      y += 62;
    }
    button(x0, y + 10, "Abrir detalhes no CyberSafe", "open");
  }

  void drawHistory(int x0, const Result<Status>& r) {
    if (offline(x0, r)) return;
    const Status& s = *r.value;
    text(x0, 40, "Histórico e alertas", theme_.fg, title_);
    int y = 72;
    text(x0, y, "Análises (últimas 5)", theme_.fg, bold_); y += 22;
    if (s.history.empty()) { text(x0, y, "Sem análises registadas.", theme_.muted); y += 22; }
    for (auto& h : s.history) {
      std::string line = h.endedAt.value_or("—") + "  " + scanText(h) + "  ficheiros " + (h.filesAnalyzed ? std::to_string(*h.filesAnalyzed) : "—") +
                         " · falhas " + (h.filesFailed ? std::to_string(*h.filesFailed) : "—") + " · inconclusivos " + (h.filesInconclusive ? std::to_string(*h.filesInconclusive) : "—");
      text(x0, y, line, theme_.muted); y += 20;
    }
    y += 16;
    text(x0, y, "Alertas recentes", theme_.fg, bold_); y += 22;
    if (s.alerts.empty()) { text(x0, y, "Sem alertas desde o arranque do serviço.", theme_.muted); y += 20; }
    for (auto& a : s.alerts) { text(x0, y, a.timestamp.value_or("—") + "  " + a.type + "  " + a.severity.value_or("—"), theme_.muted); y += 20; }
    text(x0, h_ - 30, "O contrato v1 só expõe 5 análises e 5 alertas, sem caminhos.", theme_.muted);
  }

  void drawUpdates(int x0) {
    text(x0, 40, "Atualizações do CyberSafe Linux", theme_.fg, title_);
    button(x0, 60, updateBusy_ ? "A verificar…" : "Verificar", "check-update", !updateBusy_);
    int y = 112;
    if (!update_) { text(x0, y, "Ainda não verificado nesta sessão.", theme_.muted); return; }
    if (!update_->ok()) { text(x0, y, update_->error.message, theme_.warn); return; }
    const auto& u = *update_->value;
    const char* state = u.state == UpdateState::Available ? "Nova versão disponível" : u.state == UpdateState::UpToDate ? "Atualizado"
                      : u.state == UpdateState::NotConfigured ? "Canal de atualizações ainda não configurado neste pacote"
                      : u.state == UpdateState::NoRelease ? "Ainda não há versões publicadas neste canal"
                      : u.state == UpdateState::DowngradeRefused ? "Versão do canal é anterior à instalada (recusada)"
                      : u.state == UpdateState::Invalid ? "Manifesto inválido ou assinatura recusada" : u.state == UpdateState::Error ? "Erro ao consultar o canal" : "Estado desconhecido";
    text(x0, y, state, u.state == UpdateState::Available ? theme_.accent : theme_.fg, bold_);
    text(x0, y + 24, "Instalada: " + u.installed.value_or("—") + "   Disponível: " + u.available.value_or("—"), theme_.muted);
    if (u.size) text(x0, y + 46, "Tamanho: " + std::to_string(*u.size / (1024 * 1024)) + " MB   Assinatura: " + (u.signatureVerified ? "verificada" : "não verificada"), theme_.muted);
    if (u.state == UpdateState::Available) text(x0, y + 72, "Para instalar: cybersafe-linux-update install --consent (pede autorização do sistema).", theme_.fg);
  }

  void drawSettings(int x0) {
    text(x0, 40, "Definições", theme_.fg, title_);
    text(x0, 66, "As definições de proteção vivem na aplicação CyberSafe; aqui não há interruptores sem efeito real.", theme_.muted);
    button(x0, 90, "Abrir CyberSafe", "open");
    text(x0, 150, "Dependências e motores: cybersafe-linux-diagnose", theme_.muted);
    text(x0, 172, "Canal de atualizações: cybersafe-linux-update prefs --stable | --experimental", theme_.muted);
  }

  // ── eventos ──
  void handle(XEvent& e) {
    if (e.type == ClientMessage && static_cast<Atom>(e.xclient.data.l[0]) == wmDelete_) quit_ = true;
    else if (e.type == ConfigureNotify) { w_ = e.xconfigure.width; h_ = e.xconfigure.height; }
    else if (e.type == ButtonPress) {
      for (auto& b : buttons_) if (e.xbutton.x >= b.x && e.xbutton.x < b.x + b.w && e.xbutton.y >= b.y && e.xbutton.y < b.y + b.h) { click(b.id); break; }
    } else if (e.type == KeyPress && tab_ == Tab::Scanner && !confirming_) {
      char buf[32]; KeySym ks; int n = XLookupString(&e.xkey, buf, sizeof buf, &ks, nullptr);
      if (ks == XK_BackSpace) { if (!path_.empty()) path_.pop_back(); }
      else if (ks == XK_Return) click("scan");
      else if (n > 0 && static_cast<unsigned char>(buf[0]) >= 0x20) path_.append(buf, static_cast<size_t>(n));
    }
  }
  void click(const std::string& id) {
    for (auto& [t, label] : kTabs) if (id == std::string("tab:") + label) { tab_ = t; return; }
    if (id == "refresh") poller_->refreshNow();
    else if (id == "open") { if (!client_.openApp()) setJob("Não foi possível abrir o CyberSafe."); }
    else if (id == "scan" && !path_.empty() && path_[0] == '/') confirming_ = true;
    else if (id == "unconfirm") confirming_ = false;
    else if (id == "confirm") {
      confirming_ = false;
      std::string target = path_;
      setJob("A enviar o pedido ao CyberSafe…");
      background([this, target] {
        auto r = client_.scan(target, /*consent=*/true);
        if (r.ok()) { std::lock_guard l(jobM_); scanId_ = r.value->scanId; jobMessage_ = "Pedido aceite (ID " + r.value->scanId + "). A aguardar o resultado no histórico."; }
        else setJob("Análise não iniciada: " + r.error.message);
        poller_->refreshNow();
      });
    } else if (id == "cancel") {
      std::optional<std::string> sid; { std::lock_guard l(jobM_); sid = scanId_; }
      if (sid) background([this, sid] {
        auto r = client_.cancel(*sid, /*consent=*/true);
        setJob(r.ok() ? (r.value->success ? "Cancelamento aceite pelo serviço." : "O serviço não cancelou (pode já ter terminado).") : "Cancelamento falhou: " + r.error.message);
        poller_->refreshNow();
      });
    } else if (id == "pick") {
      background([this] {
        auto p = runProcess({"/usr/bin/zenity", "--file-selection", "--title=Escolher ficheiro para analisar"}, std::chrono::minutes(10));
        if (p.exitCode == 0 && !p.out.empty()) { std::string s = p.out; while (!s.empty() && (s.back() == '\n')) s.pop_back(); std::lock_guard l(jobM_); path_ = s; }
      });
    } else if (id == "check-update") {
      updateBusy_ = true;
      background([this] { auto u = client_.updates(); std::lock_guard l(jobM_); update_ = u; updateBusy_ = false; });
    }
  }
  void setJob(std::string m) { std::lock_guard l(jobM_); jobMessage_ = std::move(m); }
};

int main(int argc, char** argv) {
  ClientConfig cfg;
  bool selfTest = false;
  std::string shots;
  for (int i = 1; i < argc; ++i) {
    std::string a = argv[i];
    if (a == "--self-test") selfTest = true;
    else if (a == "--status-binary" && i + 1 < argc) cfg.statusBinary = argv[++i];
    else if (a == "--update-binary" && i + 1 < argc) cfg.updateBinary = argv[++i];
    else if (a == "--screenshot-prefix" && i + 1 < argc) shots = argv[++i];
  }
  NotificationSink sink;
  SecurityCenter app(Client(cfg), nigorTheme(), sink);
  if (!app.open()) return 1;
  app.shotPrefix = shots;
  return app.run(selfTest);
}
