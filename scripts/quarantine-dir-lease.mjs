/**
 * TP-PAP-QUARANTINE-LEASE-20261028 — lease de DIRETÓRIOS (share3) reutilizável.
 *
 * Porquê: `pinFixture` (packages/service/src/fixture-pin.ts) fixa a cadeia de
 * diretórios com share=1 (GENERIC_READ + só FILE_SHARE_READ), o que torna o
 * restauro da quarentena IMPOSSÍVEL — o QuarantineManager restaura por
 * `fs.link`, que precisa de WRITE partilhado no diretório de destino; com
 * share=1 o link falha EBUSY. Probe benigno (scripts/quarantine-probe-dirlink-rename.mjs):
 *   share1 (READ)               → link EBUSY / rename EBUSY
 *   share3 (READ|WRITE, sem DELETE) → link OK    / rename EBUSY
 *
 * Esta função é a mesma primitiva do `pinFixture` (identidade pelo HANDLE,
 * recusa de reparse, cadeia de ancestrais top-down, release idempotente com
 * CloseHandle verificado) mas abre os diretórios com share=3
 * (FILE_SHARE_READ|FILE_SHARE_WRITE, SEM FILE_SHARE_DELETE). Assim:
 *   - `fs.link` (restauro) passa — o share3 concede WRITE ao diretório;
 *   - o rename/substituição do diretório continua EBUSY — a contenção
 *     anti-redirecção da cadeia (o objectivo do pin) é preservada;
 *   - o LEAF nunca é aberto: o rename da quarentena (isolar o ficheiro) tem
 *     de continuar possível e é validado à parte, por sonda + digest.
 *
 * Fechamento: se a abertura ou a verificação de identidade falhar, os handles
 * já obtidos são libertados e o erro propaga (fail-closed). `release()` é
 * idempotente e lança se um CloseHandle não for confirmado — o chamador
 * audita essa falha mas nunca esconde a resposta já decidida.
 *
 * Este módulo é PURO (sem side-effects): não importa o serviço, não arranca
 * nada; só abre/liberta handles de diretórios. Usado pelo script
 * `dev-quarantine-fixture-service.mjs` e testável em isolamento.
 */
import path from 'node:path';
import { createRequire } from 'node:module';

const MARCA = 'quarantine_fixture_harness';

/**
 * @param {{ nos: Map<string, { dev: bigint; ino: bigint; tipo: 'dir' | 'file' }> }} snapshot
 *   Snapshot do gate reduzido a diretórios (chaves = caminhos normalizados).
 * @returns {{ release(): void }}
 */
export function criarLeaseDiretorios(snapshot) {
  if (process.platform !== 'win32') throw new Error(`${MARCA}: locks Windows indisponíveis para a lease de diretórios`);
  const require = createRequire(import.meta.url);
  const koffi = require('koffi');
  const kernel = koffi.load('kernel32.dll');
  const open = kernel.func('void * __stdcall CreateFileW(str16 name, uint32 access, uint32 share, void *security, uint32 creation, uint32 flags, void *template)');
  const info = kernel.func('bool __stdcall GetFileInformationByHandle(void *handle, void *info)');
  const close = kernel.func('bool __stdcall CloseHandle(void *handle)');
  const handles = [];
  const release = () => {
    // Keep any unconfirmed handle for a subsequent release attempt.
    for (let i = handles.length - 1; i >= 0; i--) {
      if (close(handles[i])) handles.splice(i, 1);
    }
    if (handles.length) throw new Error(`${MARCA}: libertação de locks de diretórios não confirmada`);
  };
  try {
    const paths = new Set();
    // Pin the full lexical chain, not just the leaf: otherwise an ancestor
    // rename/junction would redirect the engine's later path-based open.
    for (const name of snapshot.nos.keys()) {
      let current = path.parse(name).root;
      for (const segment of path.relative(current, name).split(/[\\/]+/).filter(Boolean)) {
        current = path.join(current, segment); paths.add(current);
      }
    }
    for (const name of paths) {
      // GENERIC_READ + share=3 (READ|WRITE, sem DELETE): o fs.link do restauro
      // passa, mas o rename do diretório continua recusado. OPEN_REPARSE_POINT +
      // BACKUP_SEMANTICS abre diretórios sem seguir links.
      const handle = open(name, 0x80000000, 3, null, 3, 0x02200000, null);
      if (handle === null || handle === -1n || handle === 0xffffffffffffffffn) {
        throw new Error(`${MARCA}: não foi possível bloquear a cadeia de diretórios (share3)`);
      }
      handles.push(handle);
      const buffer = Buffer.alloc(52); // BY_HANDLE_FILE_INFORMATION, fixed Win32 layout.
      if (!info(handle, buffer) || (buffer.readUInt32LE(0) & 0x400) !== 0) {
        throw new Error(`${MARCA}: reparse ou identidade de handle indisponível (share3)`);
      }
      const expected = snapshot.nos.get(process.platform === 'win32' ? name.toLowerCase() : name);
      if (!expected) continue; // Ancestors above fixture root have no corpus content.
      const directory = (buffer.readUInt32LE(0) & 0x10) !== 0;
      const volume = BigInt(buffer.readUInt32LE(28));
      const ino = (BigInt(buffer.readUInt32LE(44)) << 32n) | BigInt(buffer.readUInt32LE(48));
      const size = (BigInt(buffer.readUInt32LE(32)) << 32n) | BigInt(buffer.readUInt32LE(36));
      const modified = buffer.readBigUInt64LE(20) / 10000n - 11644473600000n;
      if (volume !== expected.dev || ino !== expected.ino || directory !== (expected.tipo === 'dir') ||
          (!directory && (buffer.readUInt32LE(40) !== 1 || size !== expected.size || modified !== expected.mtimeMs))) {
        throw new Error(`${MARCA}: objecto de diretório alterado antes do lock (share3)`);
      }
    }
    return { release };
  } catch (error) {
    release();
    throw error;
  }
}
