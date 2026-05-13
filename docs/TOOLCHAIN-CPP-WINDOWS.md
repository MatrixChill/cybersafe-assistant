# Toolchain C++ no Windows (sem Visual Studio obrigatório)

## Opções válidas

1. **MSYS2 + MinGW-w64 (UCRT64)** — `g++`, `cmake`, `ninja` via `pacman` (recomendado para quem quer terminal + OSS).
2. **LLVM/Clang + CMake + Ninja** — toolchain moderna.
3. **Visual Studio 2022 + MSVC** — conveniente para quem já usa IDE Microsoft; **não é obrigatório** para compilar o `scan-engine` deste repo.

## MSYS2 — aviso `duplicated database entry`

Mensagens `error: duplicated database entry 'bash'` vêm do **pacman** (base de dados local). Muitas vezes **não impedem** a instalação de `mingw-w64-ucrt-x86_64-gcc` e `cmake`. Se persistir: `pacman -Syu` (duas vezes até estabilizar) ou reinstalar MSYS2 numa máquina limpa.

## Compilar o motor deste repositório

Ver instruções detalhadas em `packages/native-engine/README.md`.

Resumo:

```bash
cd packages/native-engine
cmake -B build -G "MinGW Makefiles" -DCMAKE_BUILD_TYPE=Release
cmake --build build
./build/scan-engine.exe --version
```

No **MSVC**:

```powershell
cmake -B build -G "Visual Studio 17 2022" -A x64
cmake --build build --config Release
```

## PATH no CMD vs MSYS2

O `g++` do MSYS2 está no ambiente **UCRT64**. No **Prompt de Comandos** do Windows pode não existir no `PATH`; usar o terminal MSYS2 **UCRT64** ou adicionar `C:\msys64\ucrt64\bin` ao PATH do utilizador (ajustar caminho conforme a instalação).
