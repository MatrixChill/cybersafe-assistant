#include "entropy.h"

#include <array>
#include <cmath>
#include <fstream>
#include <vector>

namespace cs {

double entropy_file_prefix(const std::string& path, std::size_t max_read) {
  std::ifstream in(path, std::ios::binary);
  if (!in) return 0.0;

  std::array<std::uint64_t, 256> counts{};
  std::uint64_t total = 0;
  std::vector<char> buf(64 * 1024);

  while (total < max_read) {
    const std::size_t chunk = std::min<std::size_t>(buf.size(), max_read - total);
    in.read(buf.data(), static_cast<std::streamsize>(chunk));
    const std::streamsize n = in.gcount();
    if (n <= 0) break;
    for (std::streamsize i = 0; i < n; ++i) {
      const auto uc = static_cast<unsigned char>(buf[static_cast<std::size_t>(i)]);
      counts[uc]++;
    }
    total += static_cast<std::uint64_t>(n);
  }

  if (total == 0) return 0.0;
  double H = 0.0;
  const double inv = 1.0 / static_cast<double>(total);
  for (std::uint64_t c : counts) {
    if (c == 0) continue;
    const double p = static_cast<double>(c) * inv;
    H -= p * std::log2(p);
  }
  return H;
}

}  // namespace cs
