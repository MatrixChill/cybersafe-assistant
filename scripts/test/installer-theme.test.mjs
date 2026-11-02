import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const dir = path.join(root, 'packages/desktop/build/installer');
const nsh = fs.readFileSync(path.join(dir, 'cybersafe-installer.nsh'), 'utf8');
const lang = fs.readFileSync(path.join(dir, 'cybersafe-lang.nsh'), 'utf8');
const license = path.join(root, 'assets/licenses/THIRD-PARTY-NOTICES.txt');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'packages/desktop/package.json'), 'utf8'));

function bmpHeader(name) {
  const b = fs.readFileSync(path.join(dir, name));
  return { width: b.readInt32LE(18), height: b.readInt32LE(22), bits: b.readUInt16LE(28) };
}

for (const [name, width, height] of [
  ['page-welcome.bmp', 503, 287],
  ['page-config.bmp', 503, 287],
  ['installerSidebar.bmp', 164, 314],
  ['uninstallerSidebar.bmp', 164, 314],
  ['installerHeader.bmp', 150, 57],
]) {
  test(`${name} mantém as dimensões e 24 bits`, () => {
    assert.deepEqual(bmpHeader(name), { width, height, bits: 24 });
  });
}

test('as páginas e os campos partilham a superfície escura do Core', () => {
  assert.match(nsh, /SetCtlColors \$\{CONTROL\} 0xEDF8F8 0x07151A/);
  assert.match(nsh, /SetCtlColors \$CSDirEdit 0xEDF8F8 0x07151A/);
  assert.match(nsh, /MUI_BGCOLOR "07151A"/);
  assert.match(nsh, /MUI_TEXTCOLOR "EDF8F8"/);
});

test('o atalho do menu Iniciar é escolhido no ecrã e respeitado na instalação', () => {
  assert.match(nsh, /Var CSStartMenuShortcut/);
  assert.match(nsh, /NSD_CreateCheckbox.*CS_StartMenuShortcut/);
  assert.match(nsh, /CSStartMenuShortcut == "0"/);
  assert.match(nsh, /\$newStartMenuLink/);
  assert.equal((lang.match(/LangString CS_StartMenuShortcut /g) || []).length, 26);
});

test('o botão de licença usa o documento real incluído no setup', () => {
  assert.ok(fs.existsSync(license), 'THIRD-PARTY-NOTICES.txt em falta');
  assert.match(nsh, /File "\/oname=THIRD-PARTY-NOTICES\.txt" "\$\{BUILD_RESOURCES_DIR\}/);
  assert.doesNotMatch(nsh, /File "\/oname=THIRD-PARTY-NOTICES\.txt" "\$\{PROJECT_DIR\}/);
  assert.match(nsh, /CS_LicenseBtn/);
  assert.equal((lang.match(/LangString CS_LicenseBtn /g) || []).length, 26);
});

test('o nome do produto é o título localizado em todas as línguas', () => {
  assert.equal((lang.match(/LangString CS_WelcomeTitle /g) || []).length, 26);
  assert.equal((lang.match(/LangString CS_WelcomeTitle \d+ "[^"\n]*CyberSafe Assistant[^"\n]*"/g) || []).length, 26);
});

test('o manifesto liga o include personalizado ao NSIS', () => {
  assert.equal(pkg.build.nsis.include, 'installer/cybersafe-installer.nsh');
});

test('o bitmap de fundo fica atrás dos controlos', () => {
  assert.match(nsh, /NSD_SetStretchedImage[\s\S]{0,300}SetWindowPos\(p \$CSBg/);
});
