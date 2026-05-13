#pragma once

#include <string>

#include "types.h"

namespace cs {

// Analisa cabeçalhos MZ/PE (32 ou 64 bits) de forma conservadora.
PeSummary analyze_pe_headers(const std::string& path);

}  // namespace cs
