#pragma once

#include <ostream>
#include <string>

#include "types.h"

namespace cs {

void write_scan_json(std::ostream& out, const ScanReport& r);

}  // namespace cs
