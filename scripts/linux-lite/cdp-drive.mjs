// Linux Lite — conduzir o renderer do pacote pelo DevTools do próprio Electron.
//
// Porque um script e não comandos soltos: o percurso pedido em §15 (login →
// dashboard → PC Center → Gestor de Tarefas → Scanner → MATRIX → encerramento)
// tem de ser percorrido pelo caminho que o utilizador percorre. Um `bypass`
// inventado ou um pedido HTTP direto ao backend não provam que a interface
// instalada funciona; preencher o formulário real e carregar nos botões reais,
// sim.
//
// Porque TUDO é envolvido por um closure `(async () => { … })()` por avaliação:
// os auxiliares (`els`, `txt`, …) são `const`. Num `Runtime.evaluate` sem
// closure, um `const` no topo entra no âmbito léxico GLOBAL do contexto e
// persiste entre avaliações — a segunda injecção falhava com
// `Identifier 'els' has already been declared`, e a sonda devolvia `null` sem
// exceção visível (medido na primeira corrida do `.deb` com API: o primeiro
// `PASSO` tinha valor, todos os seguintes eram `null`). Dentro de closure cada
// avaliação é independente.
//
// Os campos são preenchidos com o setter NATIVO do `HTMLInputElement` seguido
// de `input`/`change`: um React controlado ignora a atribuição direta a
// `el.value`, e o clique num formulário que ele considera vazio produz um erro
// de validação que parece defeito da aplicação mas é defeito da sonda.
//
// Uso: node cdp-drive.mjs <porta> <diretorio-saida> [fluxo|dump]
import fs from "node:fs";
import http from "node:http";
import path from "node:path";

const [PORTA, SAIDA, COMANDO = "fluxo"] = process.argv.slice(2);
if (!PORTA || !SAIDA) { console.log("USO node cdp-drive.mjs <porta> <saida-dir> [fluxo|dump]"); process.exit(2); }
fs.mkdirSync(SAIDA, { recursive: true });

// Conta SINTÉTICA: domínio `.invalid` (RFC 2606 — nenhum servidor aceita este
// endereço, nada pode ser enviado para ele) e palavra-passe descartável criada
// para o ensaio. Não há credencial pessoal nem transportada do Windows.
const CONTA = { email: "linux-lite-teste@example.invalid", senha: "Teste-Linux-Lite-2026!", nome: "Teste Linux Lite" };
// Rótulos LIDOS da navegação do pacote (medido: «Análise de Segurança» é a
// entrada do Scanner; «Scanner» não existe na barra lateral).
const VISTAS = ["Análise de Segurança", "Monitor em Tempo Real", "PC Center", "Gestor de Tarefas", "MATRIX", "Otimizar"];

const AUXILIARES = `
const els=(s)=>[...document.querySelectorAll(s)];
const txt=(e)=>((e&&e.innerText)||"").replace(/\\s+/g," ").trim();
const porTexto=(sel,t)=>els(sel).filter((e)=>!e.disabled).find((e)=>txt(e).toLowerCase().includes(t.toLowerCase()));
const porNome=(sel,t)=>els(sel).find((e)=>((e.name||"")+" "+(e.placeholder||"")+" "+(e.id||"")+" "+(e.getAttribute("aria-label")||"")).toLowerCase().includes(t.toLowerCase()));
const porRotulo=(t)=>{for(const l of els("label")){if(txt(l).toLowerCase().includes(t.toLowerCase())){const i=document.getElementById(l.htmlFor)||l.querySelector("input,select,textarea");if(i)return i;}}return null;};
const ver=(e,v)=>{const p=e.tagName==="TEXTAREA"?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(p,"value").set.call(e,v);e.dispatchEvent(new Event("input",{bubbles:true}));e.dispatchEvent(new Event("change",{bubbles:true}));};
const esperar=(ms)=>new Promise((r)=>setTimeout(r,ms));
const C=${JSON.stringify(CONTA)};
`;

class Cdp {
  constructor(url) { this.url = url; this.n = 0; this.esperas = new Map(); this.excecoes = []; }
  abrir() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.url);
      const prazo = setTimeout(() => reject(new Error("timeout_abertura")), 10000);
      this.ws.addEventListener("open", () => { clearTimeout(prazo); resolve(); });
      this.ws.addEventListener("error", (e) => { clearTimeout(prazo); reject(new Error(String(e?.message || "erro_ws"))); });
      this.ws.addEventListener("message", (ev) => {
        let m; try { m = JSON.parse(String(ev.data)); } catch { return; }
        if (m.method === "Runtime.exceptionThrown") {
          const d = m.params?.exceptionDetails;
          this.excecoes.push(`${d?.url || "?"}:${d?.lineNumber ?? "?"} ${d?.exception?.description || d?.text || "?"}`.slice(0, 220));
        }
        if (m.id && this.esperas.has(m.id)) {
          const { resolve: ok, reject: mal, prazo: p } = this.esperas.get(m.id);
          clearTimeout(p); this.esperas.delete(m.id);
          m.error ? mal(new Error(m.error.message)) : ok(m.result);
        }
      });
    });
  }
  enviar(method, params = {}) {
    const id = ++this.n;
    return new Promise((resolve, reject) => {
      const prazo = setTimeout(() => { this.esperas.delete(id); reject(new Error(`timeout_${method}`)); }, 60000);
      this.esperas.set(id, { resolve, reject, prazo });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  fechar() { try { this.ws.close(); } catch { /* já fechado */ } }
}

function lista() {
  return new Promise((resolve) => {
    const p = http.get({ host: "127.0.0.1", port: Number(PORTA), path: "/json/list", timeout: 8000 }, (res) => {
      let b = ""; res.setEncoding("utf8"); res.on("data", (c) => (b += c)); res.on("end", () => { try { resolve(JSON.parse(b)); } catch { resolve([]); } });
    });
    p.on("timeout", () => { p.destroy(); resolve([]); });
    p.on("error", () => resolve([]));
  });
}

const alvo = (await lista()).find((t) => t.type === "page" && (t.url || "").includes("index.html"));
if (!alvo) { console.log("SEM_PAGINA index.html"); process.exit(1); }
const sess = new Cdp(alvo.webSocketDebuggerUrl);
await sess.abrir();
await sess.enviar("Runtime.enable", {});
await sess.enviar("Page.enable", {});

// `corpo` é código de função: usa `return`, e os auxiliares vivem no closure.
async function avaliar(corpo) {
  const expressão = `(async () => {${AUXILIARES}${corpo}\n})()`;
  const r = await sess.enviar("Runtime.evaluate", { expression: expressão, returnByValue: true, awaitPromise: true });
  if (r?.exceptionDetails) return `EXCECAO ${r.exceptionDetails.exception?.description || r.exceptionDetails.text}`.slice(0, 220);
  return r?.result?.value ?? "SEM_VALOR";
}
const estado = () => avaliar(`
return JSON.stringify({titulo:document.title, h:els("h1,h2,h3").map(txt).slice(0,5), nav:els("nav a,nav button,aside a,aside button").map(txt).filter(Boolean).slice(0,16), linhas:els("table tbody tr").length, itens:els("li").length, campos:els("input").map((i)=>i.type||i.tagName).slice(0,8), principal:txt(document.querySelector("main")||document.body).slice(0,300)});
`);
const passo = (nome, valor) => console.log(`PASSO ${nome} ${String(valor).replace(/\s+/g, " ").slice(0, 300)}`);
async function capturar(nome) {
  try {
    const r = await sess.enviar("Page.captureScreenshot", { format: "png" });
    if (!r?.data) return console.log(`SEM_SHOT ${nome}`);
    const f = path.join(SAIDA, `${nome}.png`);
    fs.writeFileSync(f, Buffer.from(r.data, "base64"));
    console.log(`SHOT ${nome}.png bytes=${fs.statSync(f).size}`);
  } catch (e) { console.log(`SEM_SHOT ${nome} ${String(e.message).slice(0, 60)}`); }
}

passo("estado_inicial", await estado());
if (COMANDO === "dump") { passo("excecoes", sess.excecoes.length); sess.fechar(); process.exit(0); }

// 1. ecrã de entrada → formulário de criação de conta
passo("criar_conta", await avaliar(`
const b=porTexto("button,a,[role=button]","criar conta")||porTexto("button","criar");
if(!b) return "sem_botao_criar";
b.click(); await esperar(1500); return txt(b);
`));
passo("formulario", await avaliar(`
return JSON.stringify({inputs:els("input,select,textarea").map((i)=>({tipo:i.type||i.tagName,nome:i.name||"",lugar:i.placeholder||"",rotulo:txt(i.closest("label"))||(i.getAttribute("aria-label")||""),obrig:i.required})),botoes:els("button").map(txt).filter(Boolean).slice(0,12)});
`));

// 2. preencher a conta sintética e submeter
passo("submeter", await avaliar(`
const porTipo=(t)=>els("input").filter((i)=>(i.type||"").toLowerCase()===t&&!i.readOnly)[0];
const senhas=els('input[type="password"]').filter((i)=>!i.readOnly);
const e=porTipo("email")||porRotulo("email")||porRotulo("e-mail")||els("input")[0];
if(!e) return "sem_campo_email"; ver(e,C.email);
if(!senhas[0]) return "sem_campo_senha"; ver(senhas[0],C.senha);
if(senhas[1]) ver(senhas[1],C.senha);
const n=porRotulo("nome")||porNome("input","nome")||porTipo("text"); if(n) ver(n,C.nome);
const btn=els("button").find((b)=>/criar (a )?conta|regist|submeter|continuar/i.test(txt(b)));
if(!btn) return "sem_botao_submeter";
btn.click(); await esperar(6000);
return txt(btn)+" -> "+txt(document.body).slice(0,180);
`));
passo("apos_registo", await estado());
await capturar("01-pos-registo");

// 3. se o registo não tiver autenticado, entrar com a mesma conta
if (String(await estado()).includes("Inicie sessão")) {
  passo("entrar", await avaliar(`
  const e=els('input[type="email"]')[0]||porRotulo("email"); const s=els('input[type="password"]')[0];
  if(!e||!s) return "sem_campos_login";
  ver(e,C.email); ver(s,C.senha);
  const b=els("button").find((x)=>/entrar|iniciar sess/i.test(txt(x))); if(!b) return "sem_botao_entrar";
  b.click(); await esperar(7000); return txt(b);
  `));
  passo("apos_login", await estado());
  await capturar("02-pos-login");
}

// 4. percorrer as vistas, clicando na navegação real
let i = 3;
for (const vista of VISTAS) {
  const r = await avaliar(`
  const el=porTexto("nav a,nav button,aside a,aside button,[role=navigation] a,[role=navigation] button,button,a",${JSON.stringify(vista)});
  if(!el) return "sem_item";
  el.click(); await esperar(7000); return "clicado";
  `);
  passo(`vista:${vista}`, `${r} | ${await estado()}`);
  await capturar(`${String(i++).padStart(2, "0")}-${vista.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`);
}

passo("excecoes_renderer", sess.excecoes.length);
for (const e of sess.excecoes.slice(0, 3)) console.log(`EXCECAO ${e}`);
sess.fechar();
console.log(`FIM directorio=${SAIDA} ficheiros=${fs.readdirSync(SAIDA).length}`);
