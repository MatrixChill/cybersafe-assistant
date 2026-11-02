// Linux Lite — captura o que o renderer do pacote realmente mostra.
//
// Porque não `maim`: em WSLg a janela do Electron não aparece na raiz X11 que o
// `maim` fotografa. A corrida de 3be47af devolveu um ecrã branco com o cursor —
// uma captura que não mostra nada não é evidência de nada. O DevTools do próprio
// Electron (`--remote-debugging-port`) sabe o que desenhou, por isso é por aí.
//
// Uso: node cdp-shot.mjs <porta> <caminho-saida.png> [substr-do-url]
// Node 22 traz `WebSocket` global; nenhuma dependência nova.
import fs from "node:fs";

const [porta, saida, filtro = "index.html"] = process.argv.slice(2);
if (!porta || !saida) {
  console.log("USO node cdp-shot.mjs <porta> <saida.png> [filtro]");
  process.exit(2);
}

const alvos = await new Promise((resolve, reject) => {
  httpGetJson(`http://127.0.0.1:${porta}/json/list`).then(resolve, reject);
});

const pagina = (alvos || []).find((t) => t.type === "page" && (t.url || "").includes(filtro));
if (!pagina) {
  console.log(`CDP_SEM_PAGINA filtro=${filtro} alvos=${(alvos || []).length}`);
  process.exit(1);
}

const imagem = await new Promise((resolve, reject) => {
  const ws = new WebSocket(pagina.webSocketDebuggerUrl);
  const prazo = setTimeout(() => reject(new Error("timeout_esperando_screenshot")), 15000);
  ws.addEventListener("open", () => {
    ws.send(JSON.stringify({ id: 1, method: "Page.enable" }));
    ws.send(JSON.stringify({ id: 2, method: "Page.captureScreenshot", params: { format: "png" } }));
  });
  ws.addEventListener("message", (evento) => {
    let mensagem;
    try { mensagem = JSON.parse(String(evento.data)); } catch { return; }
    if (mensagem.id !== 2) return;
    clearTimeout(prazo);
    ws.close();
    if (mensagem.error) reject(new Error(mensagem.error.message));
    else resolve(mensagem.result?.data);
  });
  ws.addEventListener("error", (e) => { clearTimeout(prazo); reject(new Error(String(e?.message || "erro_ws"))); });
});

if (!imagem) { console.log("CDP_SEM_DADOS"); process.exit(1); }
fs.writeFileSync(saida, Buffer.from(imagem, "base64"));
console.log(`SHOT_CDP_OK ${saida} bytes=${fs.statSync(saida).size} alvo=${(pagina.url || "").slice(0, 80)}`);

function httpGetJson(url) {
  return new Promise((resolve, reject) => {
    import("node:http").then(({ get }) => {
      const pedido = get(url, { timeout: 8000 }, (resposta) => {
        let corpo = "";
        resposta.setEncoding("utf8");
        resposta.on("data", (c) => (corpo += c));
        resposta.on("end", () => { try { resolve(JSON.parse(corpo)); } catch (e) { reject(e); } });
      });
      pedido.on("timeout", () => { pedido.destroy(new Error("timeout_list")); });
      pedido.on("error", reject);
    });
  });
}
