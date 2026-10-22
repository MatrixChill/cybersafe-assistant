#pragma once

#include <cstdint>
#include <string>
#include <vector>

namespace cs {

struct PeSummary {
  bool valid_pe{false};
  bool is_64{false};
  std::uint16_t machine{0};
  std::uint16_t number_of_sections{0};
  std::uint32_t timestamp{0};
  std::uint32_t size_of_image{0};
  std::uint32_t import_count{0};
  bool has_suspicious_section{false};
  bool writable_executable_section{false};
  bool no_imports{false};
  std::vector<std::string> section_names;
};

struct ScanReport {
  std::string path;
  std::uint64_t file_size{0};
  std::string sha256_hex;
  double entropy{0.0};
  PeSummary pe;
  int score{0};
  std::string level;  // safe | suspicious | malicious
  std::vector<std::string> reasons;
};

}  // namespace cs
