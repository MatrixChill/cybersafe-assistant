cmake_minimum_required(VERSION 3.20)
project(cybersafe_nigor LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)
find_package(Threads REQUIRED)

# Adaptador header-only: include/cybersafe/nigor.hpp
add_library(cybersafe_nigor INTERFACE)
target_include_directories(cybersafe_nigor INTERFACE ${CMAKE_CURRENT_SOURCE_DIR}/include)
target_link_libraries(cybersafe_nigor INTERFACE Threads::Threads)

option(CYBERSAFE_NIGOR_TESTS "Compilar os testes do adaptador" ON)
option(CYBERSAFE_NIGOR_REFERENCE "Compilar o Security Center de referência (Xlib/Xft)" ON)

if(CYBERSAFE_NIGOR_TESTS)
  enable_testing()
  add_executable(test_adapter tests/test_adapter.cpp)
  target_link_libraries(test_adapter PRIVATE cybersafe_nigor)
  target_compile_options(test_adapter PRIVATE -Wall -Wextra -Werror)
  add_test(NAME adapter COMMAND test_adapter)
endif()

if(CYBERSAFE_NIGOR_REFERENCE)
  find_package(PkgConfig REQUIRED)
  pkg_check_modules(XLIBS REQUIRED IMPORTED_TARGET x11 xft)
  add_executable(cybersafe-security-center reference/security_center.cpp)
  target_link_libraries(cybersafe-security-center PRIVATE cybersafe_nigor PkgConfig::XLIBS)
  target_compile_options(cybersafe-security-center PRIVATE -Wall -Wextra)
endif()
