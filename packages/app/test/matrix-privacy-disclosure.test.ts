/**
 * TP-MATRIX-HUMAN-FAIL-20261023 / TP-MATRIX-FB2-E2E-20261023 — o que a barra de
 * privacidade e o cartão de autorização têm de mostrar.
 *
 * Estas verificações existiam escritas contra o `<details>` antigo. O gate
 * humano reprovar a conversa não é razão para as apagar: cada uma fecha uma
 * mentira diferente. Reescritas contra o markup actual, mantendo os mesmos
 * invariantes e dizendo em cada falha o que se perdeu. O E2E acrescentou o
 * cartão compacto (detalhes recolhidos, revogação acessível, alvo da máquina
 * utilizável) e a linha do processo em causa — os invariantes antigos mantêm-se.
 *
 * Limite declarado: isto lê o fonte do componente. Prova forma e ligação; não
 * prova ciclo de GUI. O que exercita comportamento é matrix-consent-pipeline
 * (efeitos e handler reais recortados), matrix-e2e-cycle e a máquina de estado.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const source = fs.readFileSync(new URL('../src/components/AIAssistant.tsx', import.meta.url), 'utf8');
const processo = fs.readFileSync(new URL('../src/lib/processMatrix.ts', import.meta.url), 'utf8');

const cartaoDe = () => {
  const i = source.indexOf("{(explicacaoPendente || autorizacaoAberta) && (");
  const j = source.indexOf("{showThinking && (", i);
  return i >= 0 && j > i ? source.slice(i, j) : "";
};

test('privacy notice stays a one-line bar, closed by default, naming the supplier and the consent state', () => {
  const barra = source.match(/data-matrix-privacy-bar[\s\S]*?<\/button>/)?.[0];
  assert.ok(barra, 'tem de existir uma barra de privacidade própria');
  assert.match(barra, /Privacidade · /, 'a barra tem de dizer que há um fornecedor externo');
  assert.match(barra, /fornecedor/, 'a barra tem de nomear o fornecedor (rótulo, nunca chave)');
  assert.match(barra, /rotuloDeConsentimento\(/, 'a barra tem de dizer o estado de autorização, não só «privacidade»');
  assert.match(barra, /data-matrix-privacy-toggle/, 'tem de haver um controlo acionável para abrir a informação');
  assert.match(barra, /aria-expanded=\{autorizacaoAberta\}/, 'o controlo tem de declarar ao leitor de ecrã se está aberto');
  assert.match(source, /const \[autorizacaoAberta, setAutorizacaoAberta\] = useState\(false\)/, 'o estado inicial tem de ser fechado');
  assert.match(source, /setAutorizacaoAberta\(!autorizacaoAberta\)/, 'o botão alterna o estado controlado');
  assert.doesNotMatch(source, /<details[^>]*\bopen\b/, 'nenhum <details> pode vir aberto por omissão');
});

test('authorization is bound to the instance actually in cause, with the field allowlist and its lifetime on screen', () => {
  const cartao = cartaoDe();
  assert.ok(cartao, 'tem de existir cartão de autorização');
  assert.match(
    source,
    /\{\(explicacaoPendente \|\| autorizacaoAberta\) && \(\s*\n\s*<div\s*\n\s*ref=\{consentCardRef\}\s*\n\s*data-matrix-consent-card/,
    'o cartão de autorização só pode aparecer com pedido pendente ou abertura explícita',
  );
  // A caixa é o estado EFECTIVO do alvo, não um booleano global.
  assert.match(cartao, /checked=\{consentimentoProcessoEfectivo\}/, 'a caixa tem de reflectir o alvo em causa');
  assert.match(
    source,
    /setAutorizacoes\(prev => autorizarAlvo\(prev, alvoConsentimento, Date\.now\(\), descriptor\.providerKey\)\)/,
    'autorizar tem de gravar o alvo concreto (processo ou máquina) e a chave do fornecedor em que foi dado',
  );
  assert.match(cartao, /recusarExplicacaoPendente\(\)/, 'desmarcar tem de ser acionável a partir de desmarcado');
  assert.match(cartao, /data-matrix-consent-authorize/, 'tem de haver botão explícito de autorizar');
  assert.match(cartao, /data-matrix-consent-decline/, 'tem de haver botão explícito de continuar localmente');
  assert.match(cartao, /data-matrix-consent-revoke/, 'tem de existir revogação explícita e sempre alcançável');
  assert.match(cartao, /disabled=\{enviando\}/, 'o botão só pode estar desactivado enquanto um envio está em curso');
  assert.match(cartao, /data-matrix-consent-details/, 'os detalhes completos têm de existir');
  assert.match(cartao, /<summary[^>]*>Ver detalhes<\/summary>/, 'os detalhes começam recolhidos');
  assert.match(cartao, /Envia ao fornecedor de IA apenas: \{CAMPOS_AUTORIZADOS\.join\(", "\)\}/, 'o âmbito tem de ser listado');
  assert.match(cartao, /Nunca envia: \{CAMPOS_NUNCAS_AUTORIZADOS\.join\(", "\)\}/, 'o que nunca sai tem de estar escrito');
  assert.match(cartao, /AMBITO_CONSENTIMENTO\.duracaoMs/, 'a duração tem de ser declarada, não implicada');
  assert.match(cartao, /data-matrix-consent-target/, 'o cartão tem de identificar o alvo (PID ou máquina)');
  assert.match(cartao, /fornecedor/, 'o cartão tem de identificar o fornecedor');
  // A derivacao effective vive na store, e o payload obedece-lhe — a decisão que
  // abre o payload é a do momento do envio, com relógio vivo.
  assert.match(source, /const alvoConsentimento = alvoParaConsentimento\(alvoActual\)/);
  assert.match(source, /const consentimentoProcessoEfectivo = !consentimentoBloqueado && \(alvoAutorizado !== null \|\| grantPersistenteActivo\)/);
  assert.match(source, /consentValeParaAlvo\(a\.alvo, alvoConsentimento\)/, 'a coincidência é com o alvo em causa');
  const inicioVivo = source.indexOf("const consentimentoVivoAgora = useCallback");
  assert.ok(inicioVivo > 0, 'a validação viva deixou de existir');
  assert.ok(
    source.slice(inicioVivo, inicioVivo + 600).includes("const local = autorizacaoValida(autorizacoesRef.current, alvoConsentimento, Date.now())"),
    'a validação é feita com relógio vivo sobre a última lista renderizada',
  );
  assert.match(source, /const consentimentoProcesso = forcarLocal \? false : consentimentoVivoAgora\(\)/, 'uma só decisão por envio');
  assert.match(source, /processPayload\(\s*anexarContexto \? processContext : null,\s*consentimentoDoPedido,\s*externo\?\.descriptor \? camposEnvio : undefined,/, 'sem autorização nada do processo sai; o 3.º argumento leva os campos validados');
  assert.match(source, /const consentimentoDoPedido = consentimento && anexarContexto/, 'o chat geral não é coberto por um grant');
  assert.match(source, /consentimento: boolean = consentimentoVivoAgora\(\)/, 'o sendToServer recebe a decisão, não a re-lê');
  assert.doesNotMatch(source, /agoraRef/, 'a hora congelada da montagem não pode voltar a decidir consentimento');
});

test('requested PID remains visible even if its instance has disappeared', () => {
  assert.match(source, /data-matrix-status-bar/);
  assert.match(source, /rotuloDoProcessoEmCausa\(\{/, 'a barra de estado tem de usar a linha única do processo em causa');
  assert.match(processo, /Instância fora das medições/, 'sem amostra da instância, diz-se isso em vez de calar o PID');
  assert.match(processo, /início não confirmado/, 'instância sem instante de arranque não se pode apresentar como confirmada');
  assert.match(processo, /Conversa geral/, 'sem processo nem máquina em causa, a barra diz que é conversa geral');
  assert.match(processo, /Esta máquina · medições do PC/, 'um pedido da máquina não pode aparecer como «sem processo»');
  assert.match(processo, /PID \$\{pid\}/, 'o PID pedido tem de aparecer na barra de estado');
  assert.match(cartaoDe() ?? "", /data-matrix-consent-target/, 'o cartão identifica o alvo a que a autorização se refere');
});

test('the chat keeps three fixed lines at most and gives the scroll area back to the messages', () => {
  const lista = source.indexOf('data-matrix-messages=""');
  assert.ok(lista > 0, 'a lista de mensagens tem de existir');
  const barras = (source.slice(0, lista).match(/className="[^"]*\bshrink-0\b[^"]*\bborder-b\b[^"]*"/g) ?? []).length;
  assert.equal(barras, 3, `faixas fixas acima da lista: ${barras} (esperado: cabeçalho, estado, privacidade)`);
  const cartao = (source.slice(lista).match(/\n\s+data-matrix-consent-card/) ?? []).length;
  assert.equal(cartao, 1, 'o cartão de autorização tem de viver DENTRO da área com scroll');
  assert.match(source, /data-matrix-messages[\s\S]{0,400}overflow-y-auto/, 'a lista de mensagens é o único sitio com scroll');
});
