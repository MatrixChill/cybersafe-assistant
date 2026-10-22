#pragma once

#include <cstdint>
#include <string>

namespace cs {

// SHA-256 (FIPS 180-4) do ficheiro; atualiza file_size com bytes lidos.
std::string sha256_hex_file(const std::string& path, std::uint64_t* file_size = nullptr);

}  // namespace cs
