# Por que o GitHub mostra sobretudo TypeScript

O GitHub usa **[Linguist](https://github.com/github-linguist/linguist)** para a barra de linguagens:

- Conta **linhas** por tipo de ficheiro no **último commit da branch padrão**.
- Ficheiros gerados, `vendor`, alguns binários e certas extensões podem ser ignorados ou reclassificados (`.gitattributes`).

## Neste monorepo

- Há **muitas** linhas `.ts`/`.tsx`/`.js` em `packages/app`, `packages/core`, `packages/service`, etc.
- Com o **`packages/native-engine`** cheio de `.cpp`/`.h` **commitados**, o **C++ passa a contar** — a percentagem depende do volume relativo.

## Ajuste fino (opcional)

Se no futuro quiseres forçar classificação (ex.: `CMakeLists.txt` como generated), usar `.gitattributes` com regras do Linguist. O caso típico aqui é só **garantir que o C++ está no Git**.

## “Última alteração há 2 semanas”

Na lista de ficheiros do GitHub, cada linha mostra o **último commit que tocou naquele caminho** — não confundir com “último push do repo”.
