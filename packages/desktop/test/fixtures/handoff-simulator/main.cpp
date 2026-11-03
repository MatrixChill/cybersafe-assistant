#include <cstdlib>
// Inert laboratory simulator. No file, registry, network or installer operations.
int main() {
  const char* code = std::getenv("CYBERSAFE_LAB_INSTALL_EXIT");
  return code ? std::atoi(code) : 0;
}
