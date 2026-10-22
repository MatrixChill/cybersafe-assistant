cmake_minimum_required(VERSION 3.20)
project(cybersafe_scan_engine LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

add_executable(scan-engine
  src/main.cpp
  src/scanner.cpp
  src/hash.cpp
  src/entropy.cpp
  src/pe_parser.cpp
  src/json_writer.cpp
)

target_include_directories(scan-engine PRIVATE "${CMAKE_CURRENT_SOURCE_DIR}/src")

if(MSVC)
  target_compile_options(scan-engine PRIVATE /W4 /permissive-)
else()
  target_compile_options(scan-engine PRIVATE -Wall -Wextra -Wpedantic)
endif()

if(MINGW)
  target_link_options(scan-engine PRIVATE -static-libgcc -static-libstdc++)
endif()

# Default output dir for single-config generators (Ninja / Make)
set_target_properties(scan-engine PROPERTIES RUNTIME_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}/bin")
