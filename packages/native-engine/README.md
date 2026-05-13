# Native scan engine (`scan-engine`)

Executável **C++17** com análise estática leve: **SHA-256**, **entropia de Shannon**, **heurísticas de PE** e **pontuação** simples. Saída em **JSON** por `stdout` para integração futura com Node (`child_process`).

## Compilar (MSYS2 UCRT64 + MinGW)

```bash
cd packages/native-engine
cmake -B build -G "MinGW Makefiles" -DCMAKE_BUILD_TYPE=Release
cmake --build build
```

O binário fica em `build/bin/scan-engine.exe` (gerador single-config) ou equivalente.

## Compilar (Visual Studio / MSVC)

```powershell
cmake -B build -G "Visual Studio 17 2022" -A x64
cmake --build build --config Release
```

Ajuste o gerador à versão instalada.

## Uso

```bash
./build/bin/scan-engine.exe --version
./build/bin/scan-engine.exe "C:\\Windows\\System32\\notepad.exe"
```

## Integração TypeScript (próximo passo)

Ver `docs/ROADMAP.md`. Padrão sugerido:

```ts
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export async function nativeScanJson(enginePath: string, filePath: string) {
  const { stdout } = await execFileAsync(enginePath, [filePath], {
    maxBuffer: 10 * 1024 * 1024,
    timeout: 60_000,
  });
  return JSON.parse(stdout);
}
```

## Limitações (honestidade técnica)

- Não executa YARA nativo (isso continua no `@cybersafe/core` via YARA-X até haver *binding* ou regras duplicadas).
- Heurísticas de PE são **conservadoras** e podem gerar falsos positivos/negativos; servem como **segunda opinião** estática.
- Não substitui motor em kernel nem proteção pre-exec.
