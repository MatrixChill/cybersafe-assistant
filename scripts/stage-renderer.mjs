// Pré-passo do packaging: compila a app (renderer), compila o shell desktop e
// copia o renderer para dentro de dist/ do desktop, para que o electron-builder
// empacote um ficheiro index.html pronto a ser carregado via loadFile.
import { execSync } from "node:child_process";
import { cpSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function run(cmd, cwd = root) {
  console.log(`[staging] ${cmd}`);
  execSync(cmd, { cwd, stdio: "inherit" });
}

run("npm run build -w @cybersafe/desktop");
run("npm run build -w @cybersafe/app");

const source = path.join(root, "packages", "app", "dist");
const target = path.join(root, "packages", "desktop", "dist");

mkdirSync(target, { recursive: true });
cpSync(source, target, { recursive: true });
console.log(`[staging] Renderer copiado para ${path.relative(root, target)}`);