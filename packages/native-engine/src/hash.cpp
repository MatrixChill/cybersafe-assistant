#include "hash.h"

#include <array>
#include <cstring>
#include <fstream>
#include <iomanip>
#include <sstream>
#include <vector>

namespace cs {
namespace {

constexpr std::array<std::uint32_t, 64> K = {
    0x428a2f98u, 0x71374491u, 0xb5c0fbcfu, 0xe9b5dba5u, 0x3956c25bu, 0x59f111f1u, 0x923f82a4u, 0xab1c5ed5u,
    0xd807aa98u, 0x12835b01u, 0x243185beu, 0x550c7dc3u, 0x72be5d74u, 0x80deb1feu, 0x9bdc06a7u, 0xc19bf174u,
    0xe49b69c1u, 0xefbe4786u, 0x0fc19dc6u, 0x240ca1ccu, 0x2de92c6fu, 0x4a7484aau, 0x5cb0a9dcu, 0x76f988dau,
    0x983e5152u, 0xa831c66du, 0xb00327c8u, 0xbf597fc7u, 0xc6e00bf3u, 0xd5a79147u, 0x06ca6351u, 0x14292967u,
    0x27b70a85u, 0x2e1b2138u, 0x4d2c6dfcu, 0x53380d13u, 0x650a7354u, 0x766a0abbu, 0x81c2c92eu, 0x92722c85u,
    0xa2bfe8a1u, 0xa81a664bu, 0xc24b8b70u, 0xc76c51a3u, 0xd192e819u, 0xd6990624u, 0xf40e3585u, 0x106aa070u,
    0x19a4c116u, 0x1e376c08u, 0x2748774cu, 0x34b0bcb5u, 0x391c0cb3u, 0x4ed8aa4au, 0x5b9cca4fu, 0x682e6ff3u,
    0x748f82eeu, 0x78a5636fu, 0x84c87814u, 0x8cc70208u, 0x90befffau, 0xa4506cebu, 0xbef9a3f7u, 0xc67178f2u};

inline std::uint32_t rotr(std::uint32_t x, std::uint32_t n) { return (x >> n) | (x << (32u - n)); }

void sha256_transform(std::uint32_t state[8], const std::uint8_t block[64]) {
  std::uint32_t w[64];
  for (int i = 0; i < 16; ++i) {
    w[i] = (static_cast<std::uint32_t>(block[i * 4 + 0]) << 24) | (static_cast<std::uint32_t>(block[i * 4 + 1]) << 16) |
           (static_cast<std::uint32_t>(block[i * 4 + 2]) << 8) | (static_cast<std::uint32_t>(block[i * 4 + 3]));
  }
  for (int i = 16; i < 64; ++i) {
    const std::uint32_t s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >> 3);
    const std::uint32_t s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >> 10);
    w[i] = w[i - 16] + s0 + w[i - 7] + s1;
  }

  std::uint32_t a = state[0], b = state[1], c = state[2], d = state[3];
  std::uint32_t e = state[4], f = state[5], g = state[6], h = state[7];

  for (int i = 0; i < 64; ++i) {
    const std::uint32_t S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
    const std::uint32_t ch = (e & f) ^ ((~e) & g);
    const std::uint32_t t1 = h + S1 + ch + K[i] + w[i];
    const std::uint32_t S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
    const std::uint32_t maj = (a & b) ^ (a & c) ^ (b & c);
    const std::uint32_t t2 = S0 + maj;

    h = g;
    g = f;
    f = e;
    e = d + t1;
    d = c;
    c = b;
    b = a;
    a = t1 + t2;
  }

  state[0] += a;
  state[1] += b;
  state[2] += c;
  state[3] += d;
  state[4] += e;
  state[5] += f;
  state[6] += g;
  state[7] += h;
}

}  // namespace

std::string sha256_hex_file(const std::string& path, std::uint64_t* file_size) {
  std::ifstream in(path, std::ios::binary);
  if (!in) {
    if (file_size) *file_size = 0;
    return {};
  }

  std::uint32_t state[8] = {0x6a09e667u, 0xbb67ae85u, 0x3c6ef372u, 0xa54ff53au, 0x510e527fu, 0x9b05688cu, 0x1f83d9abu, 0x5be0cd19u};

  std::vector<std::uint8_t> buf(64 * 1024);
  std::uint64_t total = 0;
  std::vector<std::uint8_t> leftover;

  for (;;) {
    in.read(reinterpret_cast<char*>(buf.data()), static_cast<std::streamsize>(buf.size()));
    const std::streamsize n = in.gcount();
    if (n <= 0) break;

    total += static_cast<std::uint64_t>(n);
    std::size_t offset = 0;
    if (!leftover.empty()) {
      const std::size_t need = 64 - leftover.size();
      if (static_cast<std::size_t>(n) >= need) {
        std::memcpy(leftover.data() + leftover.size(), buf.data(), need);
        sha256_transform(state, leftover.data());
        offset = need;
        leftover.clear();
      } else {
        leftover.insert(leftover.end(), buf.begin(), buf.begin() + static_cast<std::ptrdiff_t>(n));
        continue;
      }
    }

    while (offset + 64 <= static_cast<std::size_t>(n)) {
      sha256_transform(state, buf.data() + offset);
      offset += 64;
    }
    const std::size_t rem = static_cast<std::size_t>(n) - offset;
    if (rem > 0) {
      leftover.assign(buf.begin() + static_cast<std::ptrdiff_t>(offset), buf.begin() + static_cast<std::ptrdiff_t>(n));
    }
  }

  std::vector<std::uint8_t> last = std::move(leftover);
  last.push_back(0x80);
  while ((total + last.size()) % 64 != 56) {
    last.push_back(0);
  }
  const std::uint64_t bitlen = total * 8u;
  for (int i = 7; i >= 0; --i) {
    last.push_back(static_cast<std::uint8_t>((bitlen >> (i * 8)) & 0xffu));
  }

  for (std::size_t i = 0; i + 64 <= last.size(); i += 64) {
    sha256_transform(state, last.data() + i);
  }

  std::ostringstream oss;
  oss << std::hex << std::setfill('0');
  for (unsigned v : state) {
    for (int b = 3; b >= 0; --b) {
      oss << std::setw(2) << ((v >> (b * 8)) & 0xffu);
    }
  }
  if (file_size) *file_size = total;
  return oss.str();
}

}  // namespace cs
