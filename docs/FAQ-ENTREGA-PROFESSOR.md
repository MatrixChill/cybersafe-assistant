# FAQ — resposta ao professor e à banca

## “O motor devia ser em C++?”

**Sim, como evolução natural:** em produtos clássicos, o *core* de scan e parsers binários costuma ser **C/C++/Rust**. TypeScript/Node é excelente para **UI, API, orquestração e integração cloud**.

**No estado deste repo:** o motor **principal** que decide fluxo, YARA-X, base de hashes, ClamAV e quarentena está em **TypeScript**. O módulo **`packages/native-engine`** é um **executável C++** complementar (hash, entropia, parsing PE) e já está **ligado ao serviço** por uma *bridge* que reporta estados de saúde explícitos. A comparação de resultados nativos em cenários reais continua em avaliação — ver `ROADMAP.md`.

## “Por que TypeScript aparece tanto no GitHub?”

O GitHub usa **Linguist**: conta linhas por tipo de ficheiro no Git. O monorepo tem **muito** `.ts`/`.tsx`; por isso a barra de linguagens é dominada por TypeScript. Com **C++ versionado** em `packages/native-engine/src`, o C++ passa a aparecer após push (pode ser uma fatia pequena se o TS continuar a dominar).

## “Electron não é pesado demais?”

É um tradeoff: **Chromium + Node** na mesma app. Vantagem: **uma equipa**, **UI rica**, ecossistema npm. Desvantagem: RAM e disco. Alternativas: Tauri, Qt, WPF — cada uma com custo de stack diferente.

## “Isto é um antivírus de verdade?”

Depende da definição:

- **Protótipo / produto moderno de segurança:** sim — scan, regras, integrações, serviço, UI.
- **Equivalente a Defender com kernel minifilter e telemetria completa:** ainda não — faltam camadas de kernel, reputação massiva, equipa de resposta, etc.

## “O que falta para parecer indústria?”

Ver `ROADMAP.md`. Em síntese: **validação completa em máquina limpa**, **proteção contínua mais profunda**, **instalador assinado** e **muito** trabalho fora do código (assinaturas, compliance, operações).

## “API keys no código?”

O projeto usa **`process.env`** e `.env` no `.gitignore`; chaves de IA são guardadas na configuração local do utilizador (BYOK). Nunca se commitam segredos — há um auditor próprio em `scripts/audit-candidate-secrets.mjs` para verificar candidatos antes de empacotar.

## “NtCreateProcess hook?”

Em Windows moderno, soluções **suportadas** costumam envolver **minifilter**, **callbacks oficiais**, **ETW**, **AMSI**, **WFP** — não hooks clássicos estilo rootkit. Ver `WINDOWS-KERNEL-E-DRIVERS.md`.
