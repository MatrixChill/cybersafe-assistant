// Pré-passo do packaging: compila a app (renderer), compila o shell desktop e
// copia o renderer para dentro de dist/ do desktop, para que o electron-builder
// empacote um ficheiro index.html pronto a ser carregado via loadFile.
//
// Escreve também `build-identity.json` com a identidade REAL do renderer
// (version/buildId/commit do `__BUILD__`), para que o main possa mostrar a
// compilação e o commit na secção de Atualizações/«Sobre» sem os inventar.
import { execSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { verifyBuiltRenderer } from "./app-version.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function run(cmd, cwd = root) {
  console.log(`[staging] ${cmd}`);
  execSync(cmd, { cwd, stdio: "inherit" });
}

run("npm run build -w @cybersafe/desktop");
run("npm run build -w @cybersafe/app");

const source = path.join(root, "packages", "app", "dist");
const target = path.join(root, "packages", "desktop", "dist");

const productVersion = JSON.parse(readFileSync(path.join(root, "product-version.json"), "utf8"));
const verified = verifyBuiltRenderer({ distDir: source, version: productVersion.version, allowCommitUnknown: true });
if (!verified.ok || verified.identities.length === 0) {
  throw new Error(`[staging] renderer sem identidade de build verificável: ${verified.problems.join("; ")}`);
}
const identity = verified.identities[0];
writeFileSync(
  path.join(source, "build-identity.json"),
  `${JSON.stringify({ version: identity.version, buildId: identity.buildId, commit: identity.commit }, null, 2)}\n`,
);

mkdirSync(target, { recursive: true });
cpSync(source, target, { recursive: true });
console.log(`[staging] Renderer copiado para ${path.relative(root, target)}`);