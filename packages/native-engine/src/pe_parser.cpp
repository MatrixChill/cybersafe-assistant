#include "pe_parser.h"

#include <algorithm>
#include <cctype>
#include <cstring>
#include <fstream>
#include <string>
#include <vector>

namespace cs {

namespace {

bool read_all_prefix(std::ifstream& in, std::vector<std::uint8_t>& out, std::size_t max_bytes) {
  out.assign(max_bytes, 0);
  in.read(reinterpret_cast<char*>(out.data()), static_cast<std::streamsize>(max_bytes));
  const std::streamsize n = in.gcount();
  out.resize(static_cast<std::size_t>(std::max<std::streamsize>(n, 0)));
  return n >= 2;
}

bool ends_with_ci(const std::string& s, const char* suf) {
  const std::size_t ls = s.size();
  const std::size_t lu = std::strlen(suf);
  if (ls < lu) return false;
  for (std::size_t i = 0; i < lu; ++i) {
    const char a = static_cast<char>(std::tolower(static_cast<unsigned char>(s[ls - lu + i])));
    const char b = static_cast<char>(std::tolower(static_cast<unsigned char>(suf[i])));
    if (a != b) return false;
  }
  return true;
}

}  // namespace

PeSummary analyze_pe_headers(const std::string& path) {
  PeSummary s{};
  std::ifstream in(path, std::ios::binary);
  if (!in) return s;

  std::vector<std::uint8_t> raw;
  if (!read_all_prefix(in, raw, 512 * 1024)) return s;
  if (raw.size() < 0x40) return s;
  if (raw[0] != 'M' || raw[1] != 'Z') return s;

  const std::uint32_t pe_off = static_cast<std::uint32_t>(raw[0x3c]) | (static_cast<std::uint32_t>(raw[0x3d]) << 8) |
                               (static_cast<std::uint32_t>(raw[0x3e]) << 16) | (static_cast<std::uint32_t>(raw[0x3f]) << 24);
  if (pe_off + 4 > raw.size()) return s;
  if (raw[pe_off] != 'P' || raw[pe_off + 1] != 'E' || raw[pe_off + 2] != 0 || raw[pe_off + 3] != 0) return s;

  s.valid_pe = true;
  const std::size_t coff = pe_off + 4;
  if (coff + 20 > raw.size()) return s;

  s.machine = static_cast<std::uint16_t>(raw[coff] | (raw[coff + 1] << 8));
  s.number_of_sections = static_cast<std::uint16_t>(raw[coff + 2] | (raw[coff + 3] << 8));
  s.timestamp = static_cast<std::uint32_t>(raw[coff + 4] | (raw[coff + 5] << 8) | (raw[coff + 6] << 16) | (raw[coff + 7] << 24));

  const std::uint16_t opt_size = static_cast<std::uint16_t>(raw[coff + 16] | (raw[coff + 17] << 8));
  const std::size_t opt_start = coff + 20;
  if (opt_start + opt_size > raw.size()) return s;

  const std::uint16_t magic = static_cast<std::uint16_t>(raw[opt_start] | (raw[opt_start + 1] << 8));
  s.is_64 = (magic == 0x20b);
  if (magic == 0x10b) {
    if (opt_start + 0x38 + 8 > raw.size()) return s;
    s.size_of_image = static_cast<std::uint32_t>(raw[opt_start + 0x38] | (raw[opt_start + 0x39] << 8) | (raw[opt_start + 0x3a] << 16) |
                                                 (raw[opt_start + 0x3b] << 24));
    const std::uint32_t import_rva = static_cast<std::uint32_t>(raw[opt_start + 0x68] | (raw[opt_start + 0x69] << 8) |
                                                                (raw[opt_start + 0x6a] << 16) | (raw[opt_start + 0x6b] << 24));
    s.import_count = import_rva ? 1 : 0;  // simplificado: presença de diretório
    s.no_imports = import_rva == 0;
  } else if (magic == 0x20b) {
    // IMAGE_OPTIONAL_HEADER64: SizeOfImage @ 0x50, DataDirectory[1] (import) @ 0x78
    if (opt_start + 0x78 + 4 > raw.size()) return s;
    s.size_of_image = static_cast<std::uint32_t>(raw[opt_start + 0x50] | (raw[opt_start + 0x51] << 8) | (raw[opt_start + 0x52] << 16) |
                                                 (raw[opt_start + 0x53] << 24));
    const std::uint32_t import_rva = static_cast<std::uint32_t>(raw[opt_start + 0x78] | (raw[opt_start + 0x79] << 8) |
                                                                (raw[opt_start + 0x7a] << 16) | (raw[opt_start + 0x7b] << 24));
    s.import_count = import_rva ? 1 : 0;
    s.no_imports = import_rva == 0;
  }

  const std::size_t first_sec = opt_start + opt_size;
  s.section_names.clear();
  for (std::uint16_t i = 0; i < s.number_of_sections && i < 32; ++i) {
    const std::size_t sec = first_sec + static_cast<std::size_t>(i) * 40;
    if (sec + 8 > raw.size()) break;
    std::string name;
    for (int j = 0; j < 8; ++j) {
      const char c = static_cast<char>(raw[sec + j]);
      if (c == 0) break;
      name.push_back(c);
    }
    s.section_names.push_back(name);
    const std::uint32_t chars = static_cast<std::uint32_t>(raw[sec + 36] | (raw[sec + 37] << 8) | (raw[sec + 38] << 16) | (raw[sec + 39] << 24));
    const bool exec = (chars & 0x20000000u) != 0;
    const bool write = (chars & 0x80000000u) != 0;
    if (exec && write) s.writable_executable_section = true;
    const std::string nl = name;
    if (ends_with_ci(nl, "upx") || ends_with_ci(nl, "themida") || ends_with_ci(nl, "vmp") || ends_with_ci(nl, ".00cfg")) {
      s.has_suspicious_section = true;
    }
  }

  return s;
}

}  // namespace cs
