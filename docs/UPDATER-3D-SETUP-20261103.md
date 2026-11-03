# Updater original 3D e identidade NSIS — 3 novembro 2026

## Implementação e comparação
A apresentação anterior do updater usava PNG inclinado e duas elipses CSS. A nova `UpdaterExperience` compõe `UpdaterWindow` com `UpdaterScene`, que carrega lazy o MESMO `CoreScene` do Dashboard, variante B/profundidade. `UpdaterWindow` continua apresentacional e pode receber outra ilustração/fallback; não é um controlador de instalação.

Fontes originais reutilizadas:
- `packages/app/src/v2/dashboard/effects/CoreScene.tsx`: Three.js imperativo, TextureLoader, toros e luzes.
- `orbitalBody.ts`: hexágono extrudido 0,42, bevel, MeshPhysicalMaterial/clearcoat e faces opacas no depth buffer.
- `orbitalPose.ts`: poses originais B e velocidades independentes; geometria e trajetórias não foram redesenhadas.
- `Effects.tsx`: BrandScene/OrbitingCore originais, mantidos no Dashboard.
- `packages/app/public/brand/symbol.png`: textura original usada pelo núcleo; logo oficial derivada dos mestres em `assets/branding/source/`. Header continua a usar `public/branding/cybersafe/symbol-flat-48.png`.
- Three.js e React já instalados. Sem dependências novas, postprocessing/DOF ou runtime de bootstrapper.

No updater, os nós coloridos de motores ficam ocultos para não sugerir estados de proteção. Materiais, iluminação e oclusão partilham a implementação original. A UI não muda ClamAV/YARA/HashDB/Native nem configurações de proteção. Limites próprios do consumidor: 30 FPS e DPR 1,25, respeitando limites inferiores da Aparência. O corpo e anéis mantêm o enquadramento responsivo do CoreScene.

## Estados e contrato real
Doze apresentações: procurar, disponível, descarregar, verificar integridade, verificar autenticidade, preparar, aguardar confirmação, instalar, aguardar reinício, concluída, erro e sem versão mais recente. O snapshot downloaded+canInstall agora apresenta confirmação; o botão continua Revisar/Rever instalação, não executa nada nesta demonstração.
O contrato AppUpdateSnapshot não tem eventos separados de autenticidade/preparação/reinício/conclusão pós-arranque. Estes estados só existem nas fixtures e no modelo visual à espera de evidências reais. Installing nunca se transforma em completed. Não foram alterados HTTPS/SHA-256/Ed25519/Authenticode/staging/handoff/diário nem gates.
Percentagem representa somente bytes conhecidos da transferência. A marca permanente de demonstração esclarece que os 64% da fixture são um exemplo; nenhuma operação real é executada. Produção exclui o laboratório e os seletores.

## Desempenho, fallback e ciclo de vida
UpdaterScene usa o AppearanceProvider existente do host. No laboratório, um provider próprio usa o perfil isolado do preview. Sem GPU habilitada, em movimento reduzido ou com opção DEV estática, o módulo do renderer não é montado. Falha de criação/context loss/textura pede fallback ao consumidor. O CoreScene mantém desconexão dos observers, cancelamento RAF, remoção dos listeners e dispose de geometrias, materiais, textura, renderer e contexto no unmount.
Isto é implementação/revisão do cleanup, não prova quantitativa de ausência de fugas. Ainda falta um ensaio prolongado de mounts/unmounts com contadores GPU/memória num ambiente adequado. Não foram medidos ganhos de FPS/CPU. A suspensão quando oculto/fora de viewport reutiliza os controlos originais.

## Decisão e implementação Setup
Escolhida Opção A: páginas NSIS/MUI existentes, sem segundo Electron, plugin WebView ou bootstrapper. Compatibilidade/UAC/upgrade/reparação/desinstalação/StartApp e runAfterFinish não foram reimplementados. O NSIS continua a extrair e mostrar o progresso real; não há timer de percentagem.
A identidade estática já existente do gerador foi preservada e acrescentada às páginas welcome/config abaixo do percurso. Mantêm-se lockup e símbolo oficiais, paleta e tipografia existentes. `branding-manifest.json` passa a declarar explicitamente static-native, sem WebGL, incluindo hashes das fontes orbitais de referência. Esses hashes são rastreabilidade da direção visual; a composição NSIS NÃO é um render Three.js nem tem geometria ou movimento equivalente. Não se promete partilha binária de React entre NSIS e app.
A Opção B exigiria um launcher autenticado, ciclo UAC/NSIS, transferência de resultados, processos órfãos, assinatura e runtime adicionais. Esse custo não foi introduzido só para animação. Uma eventual exportação estática da cena 3D pode substituir a ilustração depois de revisão visual; o gerador atual não se faz passar por essa exportação.

## Evidência e verificações
- Preview Electron 1020x740: núcleo original B animado, quatro motores ausentes, transferência demo e rodapé legíveis.
- Toggle Sem WebGL (ensaio): fallback estático observado. É fallback forçado; não é ensaio de driver ausente. Tentativas adicionais com switches Chromium de desativação 3D não deram prova de WebGL indisponível neste runtime: a cena continuou visível. Esse ensaio NÃO foi contabilizado como PASS.
- Preview 560x740: disposição em coluna e núcleo enquadrado; conteúdo usa scroll vertical. Não constitui matriz completa de DPI/monitores.
- Erro e ação Tentar novamente observados; apenas mensagem demonstrativa, sem tentativa de instalar.
- Testes app completos: 2910 aprovados (incluem os três novos de cena/estados, mais regressões orbitais existentes).
- Build/typecheck aprovados; aviso de chunks >500 kB permanece. Laboratório ausente do dist de produção.
- Teste Python de branding: aprovado, hashes e formatos; 12 testes NSIS de tema aprovados.
- Hooks reais electron-builder compilados: per-user, with-license, all-users, 3/3 aprovados. Estes binários de contrato NÃO foram executados nem provam instalação.
- Protótipo NSIS existente compilado e aberto SEM payload. Os botões são percursos de apresentação e não instalam, reparam ou desinstalam nada.

Evidências em `output/updater-original-3d/`: downloading.png, static.png, narrow-top.png, setup-native.png. O protótipo visual fica em CyberSafe-native-visual-only.exe. Screenshots não são provas de instalação.

## Ver localmente
`npm run dev --workspace @cybersafe/app -- --host 127.0.0.1 --port 5181 --strictPort`
Abrir `http://127.0.0.1:5181/?lab=updater`. Escolher os 12 estados; testar total desconhecido e fallback. Usar AppearanceProvider do produto ao integrar UpdaterExperience. Não montar um provider duplicado dentro da aplicação.
O helper temporário `output/updater-original-3d-preview.cjs` abre só esse URL em Electron local com sandbox, sem preload e userData temporário próprio. Não é uma nova janela do produto instalado.

## Integridade e limites
RC1 LAB 497e634 permanece inalterada: SHA-256 155862f6453201d052a32f1d48fe1f349d86a1f32f517097e9ed8168133896a6 novamente confirmado. Nenhuma nova candidata, freeze, assinatura, instalação, publicação, tag, Release ou ativação de confiança.
Futura candidata exige inventário/manifesto e aprovação novos. Pendentes: revisão visual humana, cenários reais de driver/movimento reduzido/DPI, medição de recursos, ligação segura aos eventos do diário e validação instalada dos novos recursos. Não declarar prontidão de release com base neste trabalho visual.
