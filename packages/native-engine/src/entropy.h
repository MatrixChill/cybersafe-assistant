#pragma once

#include <cstddef>
#include <cstdint>
#include <string>

namespace cs {

// Entropia de Shannon em [0, 8] para os primeiros `max_read` bytes (streaming).
double entropy_file_prefix(const std::string& path, std::size_t max_read = 256 * 1024);

}  // namespace cs
