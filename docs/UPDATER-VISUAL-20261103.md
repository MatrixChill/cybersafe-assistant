# Atualizador visual CyberSafe

Branch: codex/updater-visual-20261103, derivada de 497e634. Não altera a instalação RC1 nem o seu manifesto.

## Ficheiros e responsabilidades
- `packages/app/src/components/updates/updaterWindowModel.ts`: contrato visual, textos PT-PT e adaptação pura/conservadora de AppUpdateSnapshot.
- `UpdaterWindow.tsx`: apresentação reutilizável; recebe view, callbacks e marcador demo. Sem IPC, hooks do updater, timers ou rede.
- `updater-window.css`: estilos limitados às classes updater; tokens oficiais, logo oficial, layout responsivo e prefers-reduced-motion.
- `UpdaterLab.tsx`: nove fixtures manuais; callbacks apenas mostram mensagens de demonstração. Sem progressão automática ou instalação simulada oculta.
- `packages/app/src/main.tsx`: entrada lazy apenas DEV via ?lab=updater. A build de produção exclui o laboratório.
- `packages/app/test/updater-window.test.ts`: gates, progresso desconhecido/limitado, instalação não concluída, textos escapados e render dos nove estados.

## Testar localmente
Na raiz, executar `npm run dev --workspace @cybersafe/app -- --host 127.0.0.1 --port 5181 --strictPort` e abrir `http://127.0.0.1:5181/?lab=updater`. Escolher os nove estados no seletor. Total desconhecido elimina a percentagem da transferência. Os botões apenas registam ações demonstrativas; fechar não fecha o laboratório.

Validação: `npm test --workspace @cybersafe/app`, `npm run build --workspace @cybersafe/app`. Captura real Electron em `output/updater-visual/checking.png`. O preview Electron de ensaio usa perfil temporário próprio, sandbox e nenhuma preload; não é uma janela instalada do produto. Acessibilidade por teclado, tamanhos estreitos e movimento reduzido precisam de revisão humana adicional; SSR não prova interação com leitor de ecrã.

## Integração futura
O host deve importar updater-window.css, obter snapshots pelo controller existente e chamar mapUpdaterSnapshot. Deve fornecer callbacks com deriveControls/controller e manter InstallConfirmDialog e revalidação de versão no main. O botão visual diz Rever instalação: não substitui consentimento.
Preparação e conclusão não existem no snapshot atual: não são inferidas de downloaded, installing, encerramento nem 100%. Exigem eventos reais do diário e confirmação após arranque antes de ligar esses estados. O host decide abrir/fechar e cancelamento; nunca encerrar processos ao fechar esta apresentação. O componente é conteúdo de janela, não um diálogo modal com captura de foco. Para overlay, reutilizar um host modal acessível.
O mapeamento oferece apenas ações conservadoras; retry significa nova consulta, nunca repetir automaticamente instalação. CanInstall continua autoridade do main; visual não confere confiança. Progresso só representa bytes da transferência, nunca instalação sintética. Mensagens externas são texto simples.

## Limites
Sem ativação de produção, download, instalação, assinatura, certificados ou alterações de updater desktop. Sem bibliotecas novas. A versão permanece RC1. Aparência segue os tokens ativos; a demonstração observada usou tema escuro CyberSafe. A zona ilustrativa é CSS leve com assets oficiais, não uma nova cena WebGL.
