set -u
export PATH="$HOME/.local/node/bin:$PATH"
R="$HOME/cybersafe-linux-lite"
export R
echo "core_dist_version:"; grep -o "PIPE_AUTH_VERSION = [0-9]*" "$R/packages/core/dist/pipe-auth.js" | head -2
echo "service_resolved:"
cd "$R/packages/service" || exit 1
node --input-type=module -e '
const u = import.meta.resolve("@cybersafe/core");
console.log("url=" + u);
const mod = await import(u);
console.log("PIPE_AUTH_VERSION_do_modo_resolvido=" + mod.PIPE_AUTH_VERSION);
console.log("tem_makePipeProof=" + (typeof mod.makePipeProof) + " tem_generatePipeNonce=" + (typeof mod.generatePipeNonce));
' 2>&1 | head -8
echo "onde_aponta_o_node_modules:"
ls -l "$R/node_modules/@cybersafe" 2>/dev/null | head -6
ls -l "$R/packages/service/node_modules/@cybersafe" 2>/dev/null | head -6
echo "probe_directo_ao_pipe_auth_js:"
node --input-type=module -e '
const m = await import("file://" + process.env.R + "/packages/core/dist/pipe-auth.js");
console.log("chaves=" + Object.keys(m).join(","));
console.log("v=" + m.PIPE_AUTH_VERSION + " nonce=" + (typeof m.generatePipeNonce));
' R="$R" 2>&1 | head -6
