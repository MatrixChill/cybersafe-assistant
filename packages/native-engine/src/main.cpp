#include <iostream>
#include <string>

#include "json_writer.h"
#include "scanner.h"

int main(int argc, char** argv) {
  if (argc >= 2) {
    const std::string a = argv[1];
    if (a == "--version" || a == "-v") {
      std::cout << "cybersafe-scan-engine 0.1.0 (C++17)\n";
      return 0;
    }
  }

  if (argc < 2) {
    std::cerr << "Uso: scan-engine <caminho-do-ficheiro>\n";
    std::cerr << "     scan-engine --version\n";
    return 2;
  }

  const std::string path = argv[1];
  const cs::ScanReport r = cs::scan_file(path);
  cs::write_scan_json(std::cout, r);
  std::cout << '\n';
  return 0;
}
