cmake_minimum_required(VERSION 3.20)

# CRT estático no MSVC (CAND25-A). Motivo medido: o `scan-engine.exe` construído
# com a configuração anterior importa MSVCP140.dll, VCRUNTIME140.dll e
# VCRUNTIME140_1.dll (dumpbin -dependents em evidence/native-dumpbin-baseline.txt),
# ou seja, precisa do redistributable VC++ 2015-2022 instalado na máquina — sem
# ele, o quarto motor não arranca numa VM limpa. Preferiu-se reconstruir com CRT
# estático precisamente para NÃO instalar pré-requisito nenhum no host.
#
# O valor é o da documentação oficial do CMake para CMAKE_MSVC_RUNTIME_LIBRARY:
# "MultiThreaded" = /MT (estático) e "MultiThreadedDLL" = /MD (dinâmico).
# Não existe o valor "Static" — não é usado. A expressão por configuração mantém
# /MTd em Debug, para não misturar CRT estático/dinâmico entre configs.
#
# Tem de estar ANTES de project(): é em project()/na criação dos targets que o
# valor é copiado para a propriedade MSVC_RUNTIME_LIBRARY. A política CMP0091 é
# NEW por omissão desde o CMake 3.15, mas fica escrita de propósito para que o
# contrato se leia neste ficheiro.
cmake_policy(SET CMP0091 NEW)
set(CMAKE_MSVC_RUNTIME_LIBRARY "MultiThreaded$<$<CONFIG:Debug>:Debug>")

project(cybersafe_scan_engine LANGUAGES CXX)

if(WIN32)
  enable_language(C)
  find_program(CYBERSAFE_NODE node REQUIRED)
  set(handoff_source "${CMAKE_CURRENT_SOURCE_DIR}/../desktop/src/updater/windows-handoff-script.ts")
  set(handoff_generator "${CMAKE_CURRENT_SOURCE_DIR}/../../scripts/generate-update-launcher-program.mjs")
  set(handoff_header "${CMAKE_CURRENT_BINARY_DIR}/update_launcher_program.h")
  add_custom_command(OUTPUT "${handoff_header}"
    COMMAND "${CYBERSAFE_NODE}" "${handoff_generator}" "${handoff_source}" "${handoff_header}"
    DEPENDS "${handoff_source}" "${handoff_generator}"
    VERBATIM)
  add_executable(cybersafe-update-launcher src/update_launcher.cpp "${handoff_header}")
  target_include_directories(cybersafe-update-launcher PRIVATE "${CMAKE_CURRENT_BINARY_DIR}")
  target_sources(cybersafe-update-launcher PRIVATE
    third-party/monocypher/monocypher.c
    third-party/monocypher/monocypher-ed25519.c)
  target_include_directories(cybersafe-update-launcher PRIVATE third-party/monocypher)
  target_link_libraries(cybersafe-update-launcher PRIVATE crypt32 bcrypt)
  set(product_version_file "${CMAKE_CURRENT_SOURCE_DIR}/../../product-version.json")
  set_property(DIRECTORY APPEND PROPERTY CMAKE_CONFIGURE_DEPENDS "${product_version_file}")
  file(READ "${product_version_file}" product_identity)
  string(JSON launcher_version GET "${product_identity}" version)
  if(NOT launcher_version MATCHES "^[0-9]+[.][0-9]+[.][0-9]+(-rc[.][0-9]+)?$")
    message(FATAL_ERROR "Unsupported update launcher product version")
  endif()
  target_compile_definitions(cybersafe-update-launcher PRIVATE CYBERSAFE_LAUNCHER_VERSION=L\"${launcher_version}\")
  set_target_properties(cybersafe-update-launcher PROPERTIES
    RUNTIME_OUTPUT_DIRECTORY_RELEASE "${CMAKE_BINARY_DIR}/Release")
endif()

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

# Default output dir for single-config generators (Ninja / Make).
# O gerador Visual Studio (multi-config) escrevia `bin/Release/scan-engine.exe`,
# mas o contrato de packaging procura `build/Release/scan-engine.exe`
# (preflight, extraResources e source-freeze). A propriedade por configuração
# fixa o Release no caminho do contrato sem mudar Debug.
set_target_properties(scan-engine PROPERTIES
  RUNTIME_OUTPUT_DIRECTORY "${CMAKE_BINARY_DIR}/bin"
  RUNTIME_OUTPUT_DIRECTORY_RELEASE "${CMAKE_BINARY_DIR}/Release"
)
