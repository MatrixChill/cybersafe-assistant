# FAQ — resposta ao professor e à banca

## “O motor devia ser em C++?”

**Sim, como evolução natural:** em produtos clássicos, o *core* de scan e parsers binários costuma ser **C/C++/Rust**. TypeScript/Node é excelente para **UI, API, orquestração e integração cloud**.

**No estado deste repo:** o motor **principal** que decide fluxo, YARA-X, VirusTotal e quarentena está em **TypeScript**. O módulo **`packages/native-engine`** é um **executável C++** complementar para análise estática nativa; a integração no serviço é o próximo passo técnico explícito no `ROADMAP.md`.

## “Por que TypeScript aparece tanto no GitHub?”

O GitHub usa **Linguist**: conta linhas por tipo de ficheiro no Git. O monorepo tem **muito** `.ts`/`.tsx`; por isso a barra de linguagens é dominada por TypeScript. Com **C++ versionado** em `packages/native-engine/src`, o C++ passa a aparecer após push (pode ser uma fatia pequena se o TS continuar a dominar).

## “Electron não é pesado demais?”

É um tradeoff: **Chromium + Node** na mesma app. Vantagem: **uma equipa**, **UI rica**, ecossistema npm. Desvantagem: RAM e disco. Alternativas: Tauri, Qt, WPF — cada uma com custo de stack diferente.

## “Isto é um antivírus de verdade?”

Depende da definição:

- **Protótipo / produto moderno de segurança:** sim — scan, regras, integrações, serviço, UI.
- **Equivalente a Defender com kernel minifilter e telemetria completa:** ainda não — faltam camadas de kernel, reputação massiva, equipa de resposta, etc.

## “O que falta para parecer indústria?”

Ver `ROADMAP.md` fases 3–4. Em síntese: **motor nativo integrado**, **proteção contínua mais profunda**, e **muito** trabalho fora do código (assinaturas, compliance, operações).

## “API keys no código?”

O projeto deve usar **`process.env`** e `.env` no `.gitignore`. Nunca commitar segredos. Validar com `grep` antes de entregar.

## “NtCreateProcess hook?”

Em Windows moderno, soluções **suportadas** costumam envolver **minifilter**, **callbacks oficiais**, **ETW**, **AMSI**, **WFP** — não hooks clássicos estilo rootkit. Ver `WINDOWS-KERNEL-E-DRIVERS.md`.
