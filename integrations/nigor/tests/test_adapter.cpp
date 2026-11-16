// Testes do adaptador: parsing do JSON v1, estados desconhecidos, processos
// (timeout, saída inválida, offline, binário ausente) e consulta assíncrona.
#include <cybersafe/nigor.hpp>

#include <cstdio>
#include <cstdlib>
#include <fstream>
#include <iostream>
#include <sys/stat.h>

using namespace cybersafe;
static int failures = 0;
#define CHECK(c) do { if (!(c)) { std::cerr << __FILE__ << ":" << __LINE__ << " FALHOU: " #c "\n"; ++failures; } } while (0)

static std::string fixtures;

static const char* kStatus = R"({"version":1,"serviceRunning":true,
 "protection":{"status":"degraded","enabled":true},
 "engines":{"clamav":"unavailable","yara":"error","hashDb":"active","native":"active"},
 "engineReasons":{"clamav":"not-installed","yara":null,"hashDb":null,"native":null},
 "latestScan":{"status":"completed","endedAt":"2026-11-14T10:00:00.000Z","filesAnalyzed":3,"filesFailed":0,"filesInconclusive":1,"threatsFound":0},
 "history":[{"status":"completed","endedAt":"2026-11-14T10:00:00.000Z","filesAnalyzed":3,"filesFailed":0,"filesInconclusive":1,"threatsFound":0}],
 "alerts":[{"type":"threat.detected","severity":"high","timestamp":"2026-11-14T09:00:00.000Z"}],
 "alertsScope":"service-session","metrics":{"cpuPercent":12.5,"ramPercent":null}})";

static void testParse() {
  auto r = parseStatus(kStatus);
  CHECK(r.ok());
  auto& s = *r.value;
  CHECK(s.serviceRunning == true);
  CHECK(s.monitoringEnabled == true);
  CHECK(s.protection == ProtectionStatus::Degraded);
  CHECK(s.engines.clamav.state == EngineState::Unavailable);
  CHECK(s.engines.clamav.reason == EngineReason::NotInstalled);
  CHECK(engineText(s.engines.clamav) == "Não instalado");
  CHECK(s.engines.yara.state == EngineState::Error);
  CHECK(engineText(s.engines.yara) == "Erro");
  CHECK(s.latestScan && !s.latestScan->clean());
  CHECK(scanText(*s.latestScan) == "Concluída com ficheiros inconclusivos");
  CHECK(s.alerts.size() == 1 && s.alerts[0].severity == "high");
  CHECK(s.cpuPercent == 12.5);
  CHECK(!s.ramPercent.has_value());
  CHECK(!fullyProtected(s));
}

static void testUnknownIsNotSafe() {
  auto r = parseStatus(R"({"version":1,"serviceRunning":null,"protection":{"status":"weird"},"engines":{},"latestScan":null,"history":[],"alerts":[],"metrics":{}})");
  CHECK(r.ok());
  CHECK(!r.value->serviceRunning.has_value());
  CHECK(r.value->protection == ProtectionStatus::Unknown);
  CHECK(r.value->engines.native.state == EngineState::Unknown);
  CHECK(!r.value->latestScan.has_value());
  CHECK(!fullyProtected(*r.value));
  auto active = parseStatus(R"({"version":1,"serviceRunning":true,"protection":{"status":"safe","enabled":true},"engines":{"clamav":"active","yara":"active","hashDb":"active","native":"active"},"monitoring":{"mode":"post-write","preventionConfirmed":false,"queueDepth":3,"rootCount":2}})");
  CHECK(active.ok() && !fullyProtected(*active.value));
  // Contagem desconhecida não é «limpa».
  auto partial = parseStatus(R"({"version":1,"latestScan":{"status":"completed","filesAnalyzed":2}})");
  CHECK(partial.ok() && !partial.value->latestScan->clean());
}

static void testInvalidAndVersion() {
  CHECK(parseStatus("not json").error.kind == ErrorKind::InvalidResponse);
  CHECK(parseStatus("{\"version\":2}").error.kind == ErrorKind::IncompatibleVersion);
  CHECK(parseStatus("[1,2]").error.kind == ErrorKind::InvalidResponse);
  CHECK(parseStatus("{\"version\":1} trailing").error.kind == ErrorKind::InvalidResponse);
  std::string deep(100, '['); deep += std::string(100, ']');
  CHECK(!JsonParser::parse(deep).has_value());
  auto u = JsonParser::parse(R"({"s":"ação 😀"})");
  CHECK(u && u->get("s")->str() == "ação 😀");
}

static void testUpdate() {
  auto u = parseUpdate(R"({"schema":1,"state":"available","installed":"0.2.4-1","channel":"experimental","available":{"version":"0.2.5-1","size":1000,"notes":"x","signature":"ed25519-verified"}})");
  CHECK(u.ok() && u.value->state == UpdateState::Available && u.value->signatureVerified && u.value->size == 1000);
  auto nc = parseUpdate(R"({"schema":1,"state":"not-configured","installed":"0.2.4-1"})");
  CHECK(nc.ok() && nc.value->state == UpdateState::NotConfigured && !nc.value->available);
}

static std::string script(const std::string& name, const std::string& body) {
  std::string path = fixtures + "/" + name;
  std::ofstream(path) << "#!/bin/sh\n" << body << "\n";
  chmod(path.c_str(), 0755);
  return path;
}

static void testProcesses() {
  ClientConfig cfg;
  cfg.statusTimeout = std::chrono::milliseconds(800);
  cfg.actionTimeout = std::chrono::milliseconds(800);

  cfg.statusBinary = script("ok.sh", std::string("cat <<'EOF'\n") + kStatus + "\nEOF");
  CHECK(Client(cfg).status().ok());

  cfg.statusBinary = script("slow.sh", "sleep 5; echo '{}'");
  auto t0 = std::chrono::steady_clock::now();
  auto slow = Client(cfg).status();
  auto took = std::chrono::steady_clock::now() - t0;
  CHECK(slow.error.kind == ErrorKind::Timeout);
  CHECK(took < std::chrono::seconds(3));

  cfg.statusBinary = script("garbage.sh", "echo 'nao e json'");
  CHECK(Client(cfg).status().error.kind == ErrorKind::InvalidResponse);

  cfg.statusBinary = script("offline.sh", "echo 'Não foi possível concluir' >&2; exit 1");
  CHECK(Client(cfg).status().error.kind == ErrorKind::Offline);

  cfg.statusBinary = fixtures + "/nao-existe";
  CHECK(Client(cfg).status().error.kind == ErrorKind::NotInstalled);

  cfg.statusBinary = "relativo/sem-barra";
  CHECK(Client(cfg).status().error.kind == ErrorKind::NotInstalled);

  // Argumentos chegam intactos, sem shell: um caminho com ; e $() não é interpretado.
  cfg.statusBinary = script("echoargs.sh", "printf '{\"version\":1,\"accepted\":true,\"scanId\":\"abc-1\",\"argv\":\"%s|%s|%s\"}' \"$1\" \"$2\" \"$3\"");
  auto acc = Client(cfg).scan("/tmp/a; rm -rf ~ $(id)", true);
  CHECK(acc.ok() && acc.value->scanId == "abc-1");
  CHECK(Client(cfg).scan("/tmp/x", false).error.kind == ErrorKind::Refused);
  CHECK(Client(cfg).scan("relativo", true).error.kind == ErrorKind::Refused);
  CHECK(Client(cfg).cancel("abc;rm", true).error.kind == ErrorKind::Refused);

  cfg.updateBinary = fixtures + "/sem-atualizador";
  CHECK(Client(cfg).updates().error.kind == ErrorKind::NotInstalled);
}

static void testPoller() {
  ClientConfig cfg;
  cfg.statusBinary = script("ok2.sh", std::string("cat <<'EOF'\n") + kStatus + "\nEOF");
  std::atomic<int> notified{0};
  AsyncPoller poller(Client(cfg), std::chrono::milliseconds(2000), [&] { ++notified; });
  poller.start();
  for (int i = 0; i < 200 && notified == 0; ++i) std::this_thread::sleep_for(std::chrono::milliseconds(10));
  CHECK(notified >= 1);
  auto snap = poller.latest();
  CHECK(snap && snap->ok());
  poller.refreshNow();
  for (int i = 0; i < 200 && notified < 2; ++i) std::this_thread::sleep_for(std::chrono::milliseconds(10));
  CHECK(notified >= 2);
  auto t0 = std::chrono::steady_clock::now();
  poller.stop();
  CHECK(std::chrono::steady_clock::now() - t0 < std::chrono::seconds(1));
}

int main() {
  char tmpl[] = "/tmp/cs-nigor-adapter-XXXXXX";
  fixtures = mkdtemp(tmpl);
  testParse();
  testUnknownIsNotSafe();
  testInvalidAndVersion();
  testUpdate();
  testProcesses();
  testPoller();
  std::string rm = "rm -rf " + fixtures;  // diretório próprio do teste
  if (std::system(rm.c_str()) != 0) {}
  std::cout << (failures == 0 ? "OK" : "FALHAS") << " (" << failures << " falhas)\n";
  return failures == 0 ? 0 : 1;
}
