set -eu
export PATH="$HOME/.local/node/bin:$PATH"
S=/mnt/c/Users/caioc/.cybersafe-integration/qoder-linux-lite/repo
D="$HOME/cybersafe-linux-lite"

echo "node_bin=$(command -v node)"
node -e 'console.log("platform=" + process.platform + " arch=" + process.arch + " version=" + process.version)'
echo "getconf_CLK_TCK=$(getconf CLK_TCK) getconf_PAGESIZE=$(getconf PAGESIZE)"
echo "interop_powershell=$(command -v powershell.exe || echo ausente)"

echo "== fornecedor POSIX direto em Linux real =="
cd "$D"
node -e '
const { PosixProcessProvider } = require("./packages/core/dist/process-provider-posix.js");
const p = new PosixProcessProvider();
const inicio = Date.now();
const linhas = p.list();
console.log("linhas=" + linhas.length + " ms_na_primeira_enum=" + (Date.now() - inicio));
console.log("constantes=" + JSON.stringify(p.constantes()));
console.log("startedAt=" + linhas.filter((l) => l.startedAt).length + " path=" + linhas.filter((l) => l.path).length + " user=" + linhas.filter((l) => l.user).length);
for (const l of linhas.filter((x) => x.startedAt).slice(0, 3)) {
  console.log("linha: " + l.name + " pid=" + l.pid + " user=" + l.user + " cpu=" + l.cpu.toFixed(2) + " ram=" + l.memoryMb.toFixed(1) + "MB inicio=" + l.startedAt + " path=" + l.path);
}
const t2 = Date.now();
const segunda = p.list();
console.log("ms_segunda_enum=" + (Date.now() - t2) + " linhas=" + segunda.length);
'

echo "== o serviço compilado tem o ramo POSIX? =="
grep -c "posixProcessProvider" "$D/packages/service/dist/engine.js" || echo "0 ocorrencias em dist/engine.js"
grep -c "enumerateProcesses" "$D/packages/service/src/engine.ts" || echo "0 ocorrencias em src/engine.ts"
