#include "json_writer.h"

#include <iomanip>
#include <sstream>

namespace cs {
namespace {

void write_escaped(std::ostream& out, const std::string& s) {
  out << '"';
  for (char c : s) {
    switch (c) {
      case '\\':
        out << "\\\\";
        break;
      case '"':
        out << "\\\"";
        break;
      case '\b':
        out << "\\b";
        break;
      case '\f':
        out << "\\f";
        break;
      case '\n':
        out << "\\n";
        break;
      case '\r':
        out << "\\r";
        break;
      case '\t':
        out << "\\t";
        break;
      default:
        if (static_cast<unsigned char>(c) < 0x20) {
          const auto u = static_cast<unsigned char>(c);
          static const char* hexd = "0123456789abcdef";
          out << "\\u00" << hexd[(u >> 4) & 0xf] << hexd[u & 0xf];
        } else {
          out << c;
        }
    }
  }
  out << '"';
}

}  // namespace

void write_scan_json(std::ostream& out, const ScanReport& r) {
  out << '{';
  out << "\"path\":";
  write_escaped(out, r.path);
  out << ",\"file_size\":" << r.file_size;
  out << ",\"sha256\":";
  write_escaped(out, r.sha256_hex);
  {
    std::ostringstream ent;
    ent << std::fixed << std::setprecision(4) << r.entropy;
    out << ",\"entropy\":" << ent.str();
  }
  out << ",\"score\":" << r.score;
  out << ",\"level\":";
  write_escaped(out, r.level);
  out << ",\"reasons\":[";
  for (std::size_t i = 0; i < r.reasons.size(); ++i) {
    if (i) out << ',';
    write_escaped(out, r.reasons[i]);
  }
  out << "],\"pe\":{";
  out << "\"valid_pe\":" << (r.pe.valid_pe ? "true" : "false");
  out << ",\"is_64\":" << (r.pe.is_64 ? "true" : "false");
  out << ",\"machine\":" << r.pe.machine;
  out << ",\"sections\":" << r.pe.number_of_sections;
  out << ",\"writable_executable_section\":" << (r.pe.writable_executable_section ? "true" : "false");
  out << ",\"no_imports\":" << (r.pe.no_imports ? "true" : "false");
  out << ",\"suspicious_section\":" << (r.pe.has_suspicious_section ? "true" : "false");
  out << "}";
  out << '}';
}

}  // namespace cs
