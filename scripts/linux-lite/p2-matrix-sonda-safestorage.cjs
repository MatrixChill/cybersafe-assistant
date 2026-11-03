// Sonda de verdade sobre o `safeStorage` do Electron em Linux.
// Não escreve chaves reais: cifra apenas um literal de sintaxe.
const { app, safeStorage } = require("electron");
const fs = require("node:fs");
const os = require("node:os");

app.whenReady().then(() => {
  let backend = null;
  let backendErro = null;
  try {
    backend = safeStorage.getSelectedStorageBackend();
  } catch (erro) {
    backendErro = String(erro && erro.message ? erro.message : erro);
  }
  let disponivel = false;
  let disponivelErro = null;
  try {
    disponivel = safeStorage.isEncryptionAvailable();
  } catch (erro) {
    disponivelErro = String(erro && erro.message ? erro.message : erro);
  }
  let idaCifradaCurta = null;
  if (disponivel) {
    const bytes = safeStorage.encryptString("sonda-de-sintaxe");
    idaCifradaCurta = bytes.subarray(0, 8).toString("hex");
  }
  // Ficheiro 0600 num diretório 0700: é o que a alternativa local promete.
  let modo0600 = null;
  try {
    const dir = fs.mkdtempSync(os.tmpdir() + "/cs-sonda-");
    const ficheiro = dir + "/f";
    const fd = fs.openSync(ficheiro, "wx", 0o600);
    fs.writeFileSync(fd, "x");
    fs.closeSync(fd);
    modo0600 = (fs.statSync(ficheiro).mode & 0o777).toString(8);
    fs.rmSync(dir, { recursive: true, force: true });
  } catch (erro) {
    modo0600 = "erro: " + String(erro && erro.code ? erro.code : erro);
  }
  console.log(
    "SONDA " +
      JSON.stringify({
        plataforma: process.platform,
        electron: process.versions.electron,
        node: process.versions.node,
        display: process.env.DISPLAY || null,
        desktop: process.env.XDG_CURRENT_DESKTOP || null,
        runtimeDir: process.env.XDG_RUNTIME_DIR ? "definido" : "ausente",
        backend,
        backendErro,
        disponivel,
        disponivelErro,
        idaCifradaCurta,
        modo0600,
      }),
  );
  app.exit(0);
});
