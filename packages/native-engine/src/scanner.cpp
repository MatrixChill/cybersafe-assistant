#include "scanner.h"

#include <filesystem>
#include <vector>

#include "entropy.h"
#include "hash.h"
#include "pe_parser.h"

namespace cs {

namespace {

void add_reason(std::vector<std::string>& reasons, const char* tag, int weight, int& score) {
  reasons.emplace_back(tag);
  score += weight;
}

bool double_extension(const std::string& p) {
  const auto pos = p.find_last_of("\\/");
  const std::string name = (pos == std::string::npos) ? p : p.substr(pos + 1);
  const auto dot = name.find_last_of('.');
  if (dot == std::string::npos || dot == 0) return false;
  const auto dot2 = name.find_last_of('.', dot - 1);
  return dot2 != std::string::npos;
}

}  // namespace

ScanReport scan_file(const std::string& path) {
  ScanReport r;
  r.path = path;

  if (!std::filesystem::exists(path)) {
    // Ficheiro inexistente e falha de analise, nunca "safe": um erro
    // nao pode aparecer como resultado limpo.
    r.level = "error";
    r.reasons.push_back("file_not_found");
    return r;
  }

  r.file_size = static_cast<std::uint64_t>(std::filesystem::file_size(path));
  r.sha256_hex = sha256_hex_file(path, &r.file_size);
  r.entropy = entropy_file_prefix(path, 256 * 1024);
  r.pe = analyze_pe_headers(path);

  int score = 0;

  if (r.entropy >= 7.9) add_reason(r.reasons, "very_high_entropy", 25, score);
  else if (r.entropy >= 7.2) add_reason(r.reasons, "elevated_entropy", 5, score);

  if (r.pe.valid_pe) {
    if (r.pe.has_suspicious_section) add_reason(r.reasons, "packed_or_protected_section", 30, score);
    if (r.pe.writable_executable_section) add_reason(r.reasons, "writable_code_section", 25, score);
    if (r.pe.no_imports) add_reason(r.reasons, "no_imports", 20, score);
    if (r.pe.number_of_sections > 12) add_reason(r.reasons, "excessive_sections", 10, score);
    if (r.file_size > 0 && r.file_size < 5 * 1024 && r.pe.valid_pe) add_reason(r.reasons, "suspiciously_small_pe", 15, score);
    if (r.pe.number_of_sections <= 2 && r.entropy >= 7.4) add_reason(r.reasons, "minimal_sections_high_entropy", 15, score);
  }

  if (double_extension(path)) add_reason(r.reasons, "double_extension", 20, score);

  if (score > 100) score = 100;
  r.score = score;
  if (score <= 25) r.level = "safe";
  else if (score <= 65) r.level = "suspicious";
  else r.level = "malicious";

  return r;
}

}  // namespace cs
