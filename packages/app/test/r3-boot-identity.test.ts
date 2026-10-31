import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// Ronda 3 · P1 pequeno — identidade do arranque.
// O arranque foi aprovado humanamente (uma camada, sem menu nativo): estes
// guardas não reabrem a arquitetura, só fixam duas promessas visuais.
//
// O ecrã de arranque vive agora em `components/BootScreen.tsx` e o de sessão
// continua no App. A promessa é a MESMA — dois ecrãs, duas marcas oficiais —
// por isso o pin lê os dois ficheiros e exige uma ocorrência em cada, em vez de
// contar duas num só (o que daria RED legítimo depois da extracção).
const APP = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
const BOOT = readFileSync(new URL("../src/components/BootScreen.tsx", import.meta.url), "utf8");

const MARCA = /<BrandLogo size="md" variant="auto" label="" \/>/g;

function usosDeMarca(fonte: string): number {
  return fonte.match(new RegExp(MARCA.source, "g"))?.length ?? 0;
}

describe("Ronda 3 — identidade do arranque", () => {
  test("BootScreen e AuthLoadingScreen usam o logótipo oficial, não um escudo genérico", () => {
    assert.match(APP, /import \{ BrandLogo \} from "\.\/components\/BrandLogo"/);
    assert.match(BOOT, /import \{ BrandLogo \} from "\.\/BrandLogo"/);
    assert.equal(usosDeMarca(APP), 1, "o ecrã de verificação de sessão usa a marca");
    assert.equal(usosDeMarca(BOOT), 1, "o ecrã de arranque usa a marca");
    assert.equal(usosDeMarca(APP) + usosDeMarca(BOOT), 2, "os dois ecrãs de arranque usam a marca");
    assert.doesNotMatch(APP, /<Shield\b/, "o escudo lucide saiu do arranque — a marca vive num só sítio");
    assert.doesNotMatch(BOOT, /<Shield\b/, "o escudo lucide saiu do arranque — a marca vive num só sítio");
  });

  test("o passo do arranque verifica o estado da proteção — nunca promete ativá-la", () => {
    assert.match(APP, /A verificar estado da proteção/, "o passo diz o que realmente faz");
    assert.doesNotMatch(APP, /A iniciar proteção/, "prometer iniciar proteção no arranque era mentira: ativá-la é ação do utilizador");
    assert.doesNotMatch(BOOT, /A iniciar proteção/, "o componente extraído não pode reintroduzir a promessa");
  });
});
