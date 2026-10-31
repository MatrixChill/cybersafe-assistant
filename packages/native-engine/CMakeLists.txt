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
