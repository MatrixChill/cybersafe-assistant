// Sincroniza o logo da marca (assets/branding/*.png) para onde a aplicação
// consegue consumi-lo. Se não existir nenhum logo, o processo é no-op e o
// app usa os ícones/fallbacks padrões.
import { cpSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const brandingDir = path.join(repoRoot, "assets", "branding");

const targets = [
  path.join(repoRoot, "packages", "app", "public", "branding"),
  path.join(repoRoot, "packages", "desktop", "src", "assets"),
];

if (!existsSync(brandingDir)) {
  console.log("[branding] Sem assets/branding — usando ícones padrão.");
  process.exit(0);
}

let copied = 0;
for (const file of readdirSync(brandingDir)) {
  if (!file.toLowerCase().endsWith(".png")) continue;
  for (const target of targets) {
    mkdirSync(target, { recursive: true });
    cpSync(path.join(brandingDir, file), path.join(target, file));
    copied += 1;
  }
}

console.log(`[branding] ${copied} asset(s) de marca sincronizados.`);