// CyberSafe ↔ Nigor OS — adaptador nativo C++20 (header-only).
//
// Usa SÓ os clientes oficiais instalados pelo pacote CyberSafe:
//   /usr/bin/cybersafe-nigor-status   (estado JSON v1, scan/cancel consentidos)
//   /usr/bin/cybersafe-linux-update   (estado das atualizações Linux)
// Não lê credenciais, não abre o socket do serviço, não usa shell: os
// argumentos vão por execv. Cada consulta tem timeout e o processo filho é
// terminado (SIGKILL) se não responder. `AsyncPoller` corre as consultas numa
// thread própria para a interface gráfica nunca bloquear.
//
// Regra de honestidade: campo ausente ou desconhecido → Unknown / std::nullopt,
// nunca "seguro"; uma análise aceite NÃO é uma análise concluída.
#pragma once

#include <algorithm>
#include <atomic>
#include <cctype>
#include <cstdlib>
#include <cerrno>
#include <chrono>
#include <condition_variable>
#include <csignal>
#include <cstdint>
#include <cstring>
#include <functional>
#include <map>
#include <memory>
#include <mutex>
#include <optional>
#include <string>
#include <string_view>
#include <thread>
#include <utility>
#include <variant>
#include <vector>

#include <fcntl.h>
#include <poll.h>
#include <sys/wait.h>
#include <unistd.h>

namespace cybersafe {

// ───────────────────────────── JSON mínimo ─────────────────────────────
struct Json;
using JsonObject = std::map<std::string, Json, std::less<>>;
using JsonArray = std::vector<Json>;

struct Json {
  std::variant<std::nullptr_t, bool, double, std::string, JsonArray, JsonObject> v{nullptr};
  bool is_null() const { return std::holds_alternative<std::nullptr_t>(v); }
  const Json* get(std::string_view key) const {
    if (auto* o = std::get_if<JsonObject>(&v)) {
      auto it = o->find(key);
      return it == o->end() ? nullptr : &it->second;
    }
    return nullptr;
  }
  std::optional<std::string> str() const { if (auto* s = std::get_if<std::string>(&v)) return *s; return std::nullopt; }
  std::optional<double> num() const { if (auto* d = std::get_if<double>(&v)) return *d; return std::nullopt; }
  std::optional<bool> boolean() const { if (auto* b = std::get_if<bool>(&v)) return *b; return std::nullopt; }
  const JsonArray* arr() const { return std::get_if<JsonArray>(&v); }
};

class JsonParser {
 public:
  static std::optional<Json> parse(std::string_view text) {
    JsonParser p{text};
    p.ws();
    auto value = p.value(0);
    if (!value) return std::nullopt;
    p.ws();
    if (p.i != p.s.size()) return std::nullopt;
    return value;
  }

 private:
  explicit JsonParser(std::string_view t) : s(t) {}
  std::string_view s;
  size_t i = 0;
  static constexpr int kMaxDepth = 32;

  void ws() { while (i < s.size() && (s[i] == ' ' || s[i] == '\n' || s[i] == '\r' || s[i] == '\t')) ++i; }
  bool lit(std::string_view w) { if (s.substr(i, w.size()) == w) { i += w.size(); return true; } return false; }

  std::optional<Json> value(int depth) {
    if (depth > kMaxDepth || i >= s.size()) return std::nullopt;
    char c = s[i];
    if (c == '{') return object(depth);
    if (c == '[') return array(depth);
    if (c == '"') { auto st = string(); if (!st) return std::nullopt; return Json{*st}; }
    if (lit("true")) return Json{true};
    if (lit("false")) return Json{false};
    if (lit("null")) return Json{nullptr};
    return number();
  }
  std::optional<Json> number() {
    size_t start = i;
    if (i < s.size() && s[i] == '-') ++i;
    bool digits = false;
    while (i < s.size() && ((s[i] >= '0' && s[i] <= '9') || s[i] == '.' || s[i] == 'e' || s[i] == 'E' || s[i] == '+' || s[i] == '-')) { digits = true; ++i; }
    if (!digits) return std::nullopt;
    std::string tmp(s.substr(start, i - start));
    char* end = nullptr;
    errno = 0;
    double d = std::strtod(tmp.c_str(), &end);
    if (end != tmp.c_str() + tmp.size() || errno == ERANGE) return std::nullopt;
    return Json{d};
  }
  static void utf8(std::string& out, uint32_t cp) {
    if (cp < 0x80) out += char(cp);
    else if (cp < 0x800) { out += char(0xC0 | (cp >> 6)); out += char(0x80 | (cp & 0x3F)); }
    else if (cp < 0x10000) { out += char(0xE0 | (cp >> 12)); out += char(0x80 | ((cp >> 6) & 0x3F)); out += char(0x80 | (cp & 0x3F)); }
    else { out += char(0xF0 | (cp >> 18)); out += char(0x80 | ((cp >> 12) & 0x3F)); out += char(0x80 | ((cp >> 6) & 0x3F)); out += char(0x80 | (cp & 0x3F)); }
  }
  std::optional<uint32_t> hex4() {
    if (i + 4 > s.size()) return std::nullopt;
    uint32_t v = 0;
    for (int k = 0; k < 4; ++k) {
      char h = s[i++]; v <<= 4;
      if (h >= '0' && h <= '9') v |= h - '0'; else if (h >= 'a' && h <= 'f') v |= h - 'a' + 10;
      else if (h >= 'A' && h <= 'F') v |= h - 'A' + 10; else return std::nullopt;
    }
    return v;
  }
  std::optional<std::string> string() {
    if (s[i] != '"') return std::nullopt;
    ++i;
    std::string out;
    while (i < s.size()) {
      char c = s[i++];
      if (c == '"') return out;
      if (static_cast<unsigned char>(c) < 0x20) return std::nullopt;
      if (c != '\\') { out += c; continue; }
      if (i >= s.size()) return std::nullopt;
      char e = s[i++];
      switch (e) {
        case '"': out += '"'; break; case '\\': out += '\\'; break; case '/': out += '/'; break;
        case 'b': out += '\b'; break; case 'f': out += '\f'; break; case 'n': out += '\n'; break;
        case 'r': out += '\r'; break; case 't': out += '\t'; break;
        case 'u': {
          auto cp = hex4(); if (!cp) return std::nullopt;
          uint32_t code = *cp;
          if (code >= 0xD800 && code <= 0xDBFF) {
            if (!lit("\\u")) return std::nullopt;
            auto lo = hex4(); if (!lo || *lo < 0xDC00 || *lo > 0xDFFF) return std::nullopt;
            code = 0x10000 + ((code - 0xD800) << 10) + (*lo - 0xDC00);
          }
          utf8(out, code); break;
        }
        default: return std::nullopt;
      }
    }
    return std::nullopt;
  }
  std::optional<Json> array(int depth) {
    ++i; JsonArray a; ws();
    if (i < s.size() && s[i] == ']') { ++i; return Json{a}; }
    while (true) {
      ws(); auto v = value(depth + 1); if (!v) return std::nullopt;
      a.push_back(std::move(*v)); ws();
      if (i < s.size() && s[i] == ',') { ++i; continue; }
      if (i < s.size() && s[i] == ']') { ++i; return Json{a}; }
      return std::nullopt;
    }
  }
  std::optional<Json> object(int depth) {
    ++i; JsonObject o; ws();
    if (i < s.size() && s[i] == '}') { ++i; return Json{o}; }
    while (true) {
      ws(); if (i >= s.size() || s[i] != '"') return std::nullopt;
      auto k = string(); if (!k) return std::nullopt;
      ws(); if (i >= s.size() || s[i] != ':') return std::nullopt; ++i; ws();
      auto v = value(depth + 1); if (!v) return std::nullopt;
      o.insert_or_assign(std::move(*k), std::move(*v)); ws();
      if (i < s.size() && s[i] == ',') { ++i; continue; }
      if (i < s.size() && s[i] == '}') { ++i; return Json{o}; }
      return std::nullopt;
    }
  }
};

// ───────────────────────────── Tipos ─────────────────────────────
enum class EngineState { Active, Degraded, Unavailable, Error, Unknown };
enum class EngineReason { None, NotInstalled, NoDefinitions, ExecFailed, Starting };
enum class ProtectionStatus { Safe, Attention, Critical, Degraded, Unknown };
enum class ScanStatus { Completed, Cancelled, Failed, Unknown };

struct Engine { EngineState state = EngineState::Unknown; EngineReason reason = EngineReason::None; };
struct Engines { Engine clamav, yara, hashDb, native; };

struct ScanSummary {
  std::optional<std::string> id;
  ScanStatus status = ScanStatus::Unknown;
  std::optional<std::string> endedAt;
  std::optional<int64_t> filesAnalyzed, filesFailed, filesInconclusive, threatsFound;
  /// Limpa SÓ se concluída, sem falhas, sem inconclusivos e sem ameaças, com contagens conhecidas.
  bool clean() const {
    return status == ScanStatus::Completed && filesFailed == 0 && filesInconclusive == 0 && threatsFound == 0 && filesAnalyzed.has_value();
  }
};

struct Alert { std::string type; std::optional<std::string> severity, timestamp, id, scanId; };

struct Status {
  int version = 0;
  std::optional<bool> serviceRunning;
  ProtectionStatus protection = ProtectionStatus::Unknown;
  std::optional<bool> monitoringEnabled;
  std::optional<std::string> monitoringMode;
  std::optional<bool> preventionConfirmed;
  std::optional<int64_t> queueDepth, monitoredRootCount;
  Engines engines;
  std::optional<ScanSummary> latestScan;
  std::vector<ScanSummary> history;
  std::vector<Alert> alerts;
  std::optional<std::string> alertsScope;
  std::optional<double> cpuPercent, ramPercent;
};

enum class UpdateState { NotConfigured, NoRelease, UpToDate, Available, DowngradeRefused, Invalid, Error, Unknown };
struct UpdateStatus {
  UpdateState state = UpdateState::Unknown;
  std::optional<std::string> installed, available, checkedAt, notes, channel;
  std::optional<int64_t> size;
  bool signatureVerified = false;
};

struct ScanAccepted { std::string scanId; };  ///< Aceite ≠ concluída.
struct CancelResult { bool success = false; };

enum class ErrorKind { None, NotInstalled, Offline, Timeout, InvalidResponse, IncompatibleVersion, Refused, SpawnFailed };
struct Error { ErrorKind kind = ErrorKind::None; std::string message; };

template <class T>
struct Result {
  std::optional<T> value;
  Error error;
  bool ok() const { return value.has_value(); }
};

// ───────────────────────────── Parsing ─────────────────────────────
namespace detail {
inline EngineState engineState(const Json* j) {
  auto s = j ? j->str() : std::nullopt;
  if (!s) return EngineState::Unknown;
  if (*s == "active") return EngineState::Active;
  if (*s == "degraded") return EngineState::Degraded;
  if (*s == "unavailable") return EngineState::Unavailable;
  if (*s == "error") return EngineState::Error;
  return EngineState::Unknown;
}
inline EngineReason engineReason(const Json* j) {
  auto s = j ? j->str() : std::nullopt;
  if (!s) return EngineReason::None;
  if (*s == "not-installed") return EngineReason::NotInstalled;
  if (*s == "no-definitions") return EngineReason::NoDefinitions;
  if (*s == "exec-failed") return EngineReason::ExecFailed;
  if (*s == "starting") return EngineReason::Starting;
  return EngineReason::None;
}
inline std::optional<int64_t> count(const Json* j) {
  auto d = j ? j->num() : std::nullopt;
  if (!d || *d < 0 || *d > 9e15 || *d != static_cast<double>(static_cast<int64_t>(*d))) return std::nullopt;
  return static_cast<int64_t>(*d);
}
inline std::optional<double> percent(const Json* j) {
  auto d = j ? j->num() : std::nullopt;
  if (!d || *d < 0 || *d > 100) return std::nullopt;
  return d;
}
inline std::optional<std::string> str(const Json* j) { return j ? j->str() : std::nullopt; }
inline ScanSummary scan(const Json& j) {
  ScanSummary s;
  s.id = str(j.get("id"));
  auto st = str(j.get("status"));
  s.status = !st ? ScanStatus::Unknown : *st == "completed" ? ScanStatus::Completed : *st == "cancelled" ? ScanStatus::Cancelled : *st == "failed" ? ScanStatus::Failed : ScanStatus::Unknown;
  s.endedAt = str(j.get("endedAt"));
  s.filesAnalyzed = count(j.get("filesAnalyzed"));
  s.filesFailed = count(j.get("filesFailed"));
  s.filesInconclusive = count(j.get("filesInconclusive"));
  s.threatsFound = count(j.get("threatsFound"));
  return s;
}
}  // namespace detail

/// Converte o JSON v1 de `cybersafe-nigor-status`. Versão ≠ 1 → IncompatibleVersion.
inline Result<Status> parseStatus(std::string_view text) {
  auto json = JsonParser::parse(text);
  if (!json || !std::holds_alternative<JsonObject>(json->v)) return {std::nullopt, {ErrorKind::InvalidResponse, "Resposta do CyberSafe ilegível."}};
  auto version = json->get("version") ? json->get("version")->num() : std::nullopt;
  if (!version || *version != 1) return {std::nullopt, {ErrorKind::IncompatibleVersion, "Versão do contrato CyberSafe incompatível."}};
  Status s;
  s.version = 1;
  if (auto* r = json->get("serviceRunning")) s.serviceRunning = r->boolean();
  if (auto* p = json->get("protection")) {
    auto st = detail::str(p->get("status"));
    s.protection = !st ? ProtectionStatus::Unknown : *st == "safe" ? ProtectionStatus::Safe : *st == "attention" ? ProtectionStatus::Attention
                 : *st == "critical" ? ProtectionStatus::Critical : *st == "degraded" ? ProtectionStatus::Degraded : ProtectionStatus::Unknown;
    if (auto* e = p->get("enabled")) s.monitoringEnabled = e->boolean();
  }
  const Json* engines = json->get("engines");
  if (auto* m = json->get("monitoring")) {
    s.monitoringMode = detail::str(m->get("mode"));
    if (auto* p = m->get("preventionConfirmed")) s.preventionConfirmed = p->boolean();
    s.queueDepth = detail::count(m->get("queueDepth"));
    s.monitoredRootCount = detail::count(m->get("rootCount"));
  }
  const Json* reasons = json->get("engineReasons");
  auto fill = [&](Engine& e, const char* key) {
    e.state = detail::engineState(engines ? engines->get(key) : nullptr);
    e.reason = detail::engineReason(reasons ? reasons->get(key) : nullptr);
  };
  fill(s.engines.clamav, "clamav"); fill(s.engines.yara, "yara"); fill(s.engines.hashDb, "hashDb"); fill(s.engines.native, "native");
  if (auto* ls = json->get("latestScan"); ls && !ls->is_null()) s.latestScan = detail::scan(*ls);
  if (auto* h = json->get("history"); h && h->arr()) for (auto& e : *h->arr()) s.history.push_back(detail::scan(e));
  if (auto* a = json->get("alerts"); a && a->arr()) {
    for (auto& e : *a->arr()) {
      auto type = detail::str(e.get("type"));
      if (!type) continue;
      s.alerts.push_back({*type, detail::str(e.get("severity")), detail::str(e.get("timestamp")), detail::str(e.get("id")), detail::str(e.get("scanId"))});
    }
  }
  s.alertsScope = detail::str(json->get("alertsScope"));
  if (auto* m = json->get("metrics")) { s.cpuPercent = detail::percent(m->get("cpuPercent")); s.ramPercent = detail::percent(m->get("ramPercent")); }
  return {s, {}};
}

inline Result<UpdateStatus> parseUpdate(std::string_view text) {
  auto json = JsonParser::parse(text);
  if (!json || !std::holds_alternative<JsonObject>(json->v)) return {std::nullopt, {ErrorKind::InvalidResponse, "Resposta do atualizador ilegível."}};
  auto schema = json->get("schema") ? json->get("schema")->num() : std::nullopt;
  if (!schema || *schema != 1) return {std::nullopt, {ErrorKind::IncompatibleVersion, "Versão do atualizador incompatível."}};
  UpdateStatus u;
  auto st = detail::str(json->get("state")).value_or("");
  u.state = st == "not-configured" ? UpdateState::NotConfigured : st == "no-release" ? UpdateState::NoRelease : st == "up-to-date" ? UpdateState::UpToDate : st == "available" ? UpdateState::Available
          : st == "downgrade-refused" ? UpdateState::DowngradeRefused : st == "invalid" ? UpdateState::Invalid : st == "error" ? UpdateState::Error : UpdateState::Unknown;
  u.installed = detail::str(json->get("installed"));
  u.checkedAt = detail::str(json->get("checkedAt"));
  u.channel = detail::str(json->get("channel"));
  if (auto* a = json->get("available"); a && !a->is_null()) {
    u.available = detail::str(a->get("version"));
    u.notes = detail::str(a->get("notes"));
    u.size = detail::count(a->get("size"));
    u.signatureVerified = detail::str(a->get("signature")).value_or("") == "ed25519-verified";
  }
  return {u, {}};
}

/// Consulta compatível com o painel: qualquer motor fora de Active impede «proteção completa».
inline bool fullyProtected(const Status& s) {
  auto active = [](const Engine& e) { return e.state == EngineState::Active; };
  return s.preventionConfirmed == true && s.serviceRunning == true && s.monitoringEnabled == true && s.protection == ProtectionStatus::Safe &&
         active(s.engines.clamav) && active(s.engines.yara) && active(s.engines.hashDb) && active(s.engines.native);
}

// ───────────────────────────── Processos ─────────────────────────────
struct ProcessOutput { int exitCode = -1; bool timedOut = false; bool spawnFailed = false; std::string out; std::string err; };

/// Executa argv[0] (caminho absoluto) com execv — sem shell, ambiente mínimo
/// herdado só para DISPLAY/HOME/XDG — e mata o filho no timeout.
inline ProcessOutput runProcess(const std::vector<std::string>& argv, std::chrono::milliseconds timeout, size_t maxBytes = 1 << 20) {
  ProcessOutput r;
  if (argv.empty() || argv[0].empty() || argv[0][0] != '/') { r.spawnFailed = true; return r; }
  int outp[2], errp[2];
  if (pipe2(outp, O_CLOEXEC) != 0) { r.spawnFailed = true; return r; }
  if (pipe2(errp, O_CLOEXEC) != 0) { close(outp[0]); close(outp[1]); r.spawnFailed = true; return r; }
  std::vector<char*> args;
  for (auto& a : argv) args.push_back(const_cast<char*>(a.c_str()));
  args.push_back(nullptr);
  pid_t pid = fork();
  if (pid < 0) { close(outp[0]); close(outp[1]); close(errp[0]); close(errp[1]); r.spawnFailed = true; return r; }
  if (pid == 0) {
    dup2(outp[1], 1); dup2(errp[1], 2);
    int devnull = open("/dev/null", O_RDONLY); if (devnull >= 0) dup2(devnull, 0);
    execv(args[0], args.data());
    _exit(127);
  }
  close(outp[1]); close(errp[1]);
  auto deadline = std::chrono::steady_clock::now() + timeout;
  pollfd fds[2] = {{outp[0], POLLIN, 0}, {errp[0], POLLIN, 0}};
  int open_fds = 2;
  char buf[4096];
  while (open_fds > 0) {
    auto left = std::chrono::duration_cast<std::chrono::milliseconds>(deadline - std::chrono::steady_clock::now()).count();
    if (left <= 0) { r.timedOut = true; break; }
    int n = poll(fds, 2, static_cast<int>(left));
    if (n < 0 && errno == EINTR) continue;
    if (n <= 0) { if (n == 0) r.timedOut = true; break; }
    for (int k = 0; k < 2; ++k) {
      if (fds[k].fd < 0 || !(fds[k].revents & (POLLIN | POLLHUP | POLLERR))) continue;
      ssize_t got = read(fds[k].fd, buf, sizeof buf);
      if (got <= 0) { close(fds[k].fd); fds[k].fd = -1; --open_fds; continue; }
      auto& dst = k == 0 ? r.out : r.err;
      if (dst.size() + static_cast<size_t>(got) <= maxBytes) dst.append(buf, static_cast<size_t>(got));
    }
  }
  for (auto& f : fds) if (f.fd >= 0) close(f.fd);
  int status = 0;
  if (r.timedOut) { kill(pid, SIGKILL); waitpid(pid, &status, 0); return r; }
  // stdout fechado: espera o fim do filho até ao prazo restante.
  while (true) {
    pid_t w = waitpid(pid, &status, WNOHANG);
    if (w == pid) break;
    if (std::chrono::steady_clock::now() >= deadline) { kill(pid, SIGKILL); waitpid(pid, &status, 0); r.timedOut = true; return r; }
    std::this_thread::sleep_for(std::chrono::milliseconds(5));
  }
  r.exitCode = WIFEXITED(status) ? WEXITSTATUS(status) : -1;
  if (r.exitCode == 127 && r.out.empty()) r.spawnFailed = true;
  return r;
}

// ───────────────────────────── Cliente ─────────────────────────────
struct ClientConfig {
  std::string statusBinary = "/usr/bin/cybersafe-nigor-status";
  std::string updateBinary = "/usr/bin/cybersafe-linux-update";
  std::string appBinary = "/usr/bin/cybersafe-assistant-linux-lite";
  std::chrono::milliseconds statusTimeout{8000};
  std::chrono::milliseconds actionTimeout{15000};
};

class Client {
 public:
  explicit Client(ClientConfig c = {}) : cfg_(std::move(c)) {}
  const ClientConfig& config() const { return cfg_; }

  Result<Status> status() const {
    auto p = runProcess({cfg_.statusBinary}, cfg_.statusTimeout);
    if (auto e = classify(p)) return {std::nullopt, *e};
    return parseStatus(p.out);
  }

  /// Pede uma análise. O chamador TEM de ter obtido consentimento explícito.
  Result<ScanAccepted> scan(const std::string& absolutePath, bool consent) const {
    if (!consent) return {std::nullopt, {ErrorKind::Refused, "Consentimento explícito em falta."}};
    if (absolutePath.empty() || absolutePath[0] != '/' || absolutePath.find('\0') != std::string::npos) return {std::nullopt, {ErrorKind::Refused, "Indique um caminho absoluto."}};
    auto p = runProcess({cfg_.statusBinary, "scan", "--consent", absolutePath}, cfg_.actionTimeout);
    if (auto e = classify(p)) return {std::nullopt, *e};
    auto j = JsonParser::parse(p.out);
    auto id = j ? (j->get("scanId") ? j->get("scanId")->str() : std::nullopt) : std::nullopt;
    auto accepted = j ? (j->get("accepted") ? j->get("accepted")->boolean() : std::nullopt) : std::nullopt;
    if (!id || accepted != true) return {std::nullopt, {ErrorKind::InvalidResponse, "Resposta de análise inválida."}};
    return {ScanAccepted{*id}, {}};
  }

  Result<CancelResult> cancel(const std::string& scanId, bool consent) const {
    if (!consent) return {std::nullopt, {ErrorKind::Refused, "Consentimento explícito em falta."}};
    for (char c : scanId) if (!(std::isalnum(static_cast<unsigned char>(c)) || c == '-')) return {std::nullopt, {ErrorKind::Refused, "Identificador inválido."}};
    if (scanId.empty() || scanId.size() > 128) return {std::nullopt, {ErrorKind::Refused, "Identificador inválido."}};
    auto p = runProcess({cfg_.statusBinary, "cancel", "--consent", scanId}, cfg_.actionTimeout);
    if (auto e = classify(p)) return {std::nullopt, *e};
    auto j = JsonParser::parse(p.out);
    auto ok = j ? (j->get("success") ? j->get("success")->boolean() : std::nullopt) : std::nullopt;
    if (!ok) return {std::nullopt, {ErrorKind::InvalidResponse, "Resposta de cancelamento inválida."}};
    return {CancelResult{*ok}, {}};
  }

  Result<UpdateStatus> updates() const {
    auto p = runProcess({cfg_.updateBinary, "check"}, cfg_.statusTimeout);
    if (p.spawnFailed) return {std::nullopt, {ErrorKind::NotInstalled, "Atualizador Linux não instalado nesta versão."}};
    if (p.timedOut) return {std::nullopt, {ErrorKind::Timeout, "O atualizador não respondeu a tempo."}};
    return parseUpdate(p.out);  // exit ≠ 0 também traz JSON com state error/invalid
  }

  /// Lança a aplicação CyberSafe na sessão do utilizador, sem argumentos privados.
  bool openApp() const {
    pid_t pid = fork();
    if (pid < 0) return false;
    if (pid == 0) {
      setsid();
      if (fork() == 0) { execl(cfg_.appBinary.c_str(), cfg_.appBinary.c_str(), static_cast<char*>(nullptr)); _exit(127); }
      _exit(0);
    }
    int st = 0; waitpid(pid, &st, 0);
    return WIFEXITED(st) && WEXITSTATUS(st) == 0;
  }

 private:
  static std::optional<Error> classify(const ProcessOutput& p) {
    if (p.spawnFailed) return Error{ErrorKind::NotInstalled, "Cliente CyberSafe não instalado."};
    if (p.timedOut) return Error{ErrorKind::Timeout, "O CyberSafe não respondeu a tempo."};
    if (p.exitCode == 2) return Error{ErrorKind::Refused, "Pedido recusado pelo cliente CyberSafe."};
    if (p.exitCode != 0) return Error{ErrorKind::Offline, "Serviço CyberSafe indisponível."};
    return std::nullopt;
  }
  ClientConfig cfg_;
};

// ───────────────────────────── Consulta assíncrona ─────────────────────────────
/// Thread de fundo que consulta o estado periodicamente (intervalo recomendado:
/// 10 s; mínimo 2 s). `onUpdate` corre NA THREAD DE FUNDO: na UI, use-o só para
/// acordar o ciclo de eventos (ex.: escrever num pipe ou XSendEvent) e leia o
/// último resultado com `latest()` na thread da interface.
class AsyncPoller {
 public:
  using Snapshot = Result<Status>;
  AsyncPoller(Client client, std::chrono::milliseconds interval, std::function<void()> onUpdate = {})
      : client_(std::move(client)), interval_(std::max(interval, std::chrono::milliseconds(2000))), onUpdate_(std::move(onUpdate)) {}
  ~AsyncPoller() { stop(); }
  AsyncPoller(const AsyncPoller&) = delete;
  AsyncPoller& operator=(const AsyncPoller&) = delete;

  void start() {
    if (thread_.joinable()) return;
    stop_ = false;
    thread_ = std::thread([this] { loop(); });
  }
  void stop() {
    { std::lock_guard l(m_); stop_ = true; }
    cv_.notify_all();
    if (thread_.joinable()) thread_.join();
  }
  /// Pede uma consulta imediata (botão Atualizar); não bloqueia.
  void refreshNow() { { std::lock_guard l(m_); refresh_ = true; } cv_.notify_all(); }
  std::optional<Snapshot> latest() const { std::lock_guard l(m_); return last_; }
  bool busy() const { return busy_.load(); }

 private:
  void loop() {
    std::unique_lock l(m_);
    while (!stop_) {
      refresh_ = false;
      l.unlock();
      busy_ = true;
      auto snap = client_.status();
      busy_ = false;
      l.lock();
      last_ = std::move(snap);
      if (onUpdate_) { l.unlock(); onUpdate_(); l.lock(); }
      cv_.wait_for(l, interval_, [this] { return stop_ || refresh_; });
    }
  }
  Client client_;
  std::chrono::milliseconds interval_;
  std::function<void()> onUpdate_;
  mutable std::mutex m_;
  std::condition_variable cv_;
  std::thread thread_;
  bool stop_ = false, refresh_ = false;
  std::atomic<bool> busy_{false};
  std::optional<Snapshot> last_;
};

// ───────────────────────────── Texto PT-PT ─────────────────────────────
inline const char* toText(EngineState s) {
  switch (s) {
    case EngineState::Active: return "Ativo";
    case EngineState::Degraded: return "Degradado";
    case EngineState::Unavailable: return "Indisponível";
    case EngineState::Error: return "Erro";
    default: return "Desconhecido";
  }
}
inline const char* toText(EngineReason r) {
  switch (r) {
    case EngineReason::NotInstalled: return "Não instalado";
    case EngineReason::NoDefinitions: return "Sem bases de assinaturas";
    case EngineReason::ExecFailed: return "Erro ao executar";
    case EngineReason::Starting: return "A verificar";
    default: return "";
  }
}
inline std::string engineText(const Engine& e) {
  if (e.state != EngineState::Active && e.reason != EngineReason::None) return toText(e.reason);
  return toText(e.state);
}
inline const char* toText(ProtectionStatus p) {
  switch (p) {
    case ProtectionStatus::Safe: return "Protegido";
    case ProtectionStatus::Attention: return "Atenção";
    case ProtectionStatus::Critical: return "Crítico";
    case ProtectionStatus::Degraded: return "Proteção com limitações";
    default: return "Estado desconhecido";
  }
}
inline std::string scanText(const ScanSummary& s) {
  if (s.status == ScanStatus::Cancelled) return "Cancelada";
  if (s.status == ScanStatus::Failed) return "Falhou";
  if (s.status != ScanStatus::Completed) return "Estado desconhecido";
  if (s.threatsFound.value_or(0) > 0) return "Ameaças encontradas: " + std::to_string(*s.threatsFound);
  if (s.filesInconclusive.value_or(0) > 0 || s.filesFailed.value_or(0) > 0) return "Concluída com ficheiros inconclusivos";
  return s.clean() ? "Concluída sem ameaças" : "Concluída (contagens incompletas)";
}

}  // namespace cybersafe
