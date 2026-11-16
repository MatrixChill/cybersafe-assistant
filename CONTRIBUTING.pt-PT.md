# Contribuir para o CyberSafe Assistant

[English](CONTRIBUTING.md) · [Código de Conduta](CODE_OF_CONDUCT.md)

Aceitam-se issues e pull requests em inglês ou português. São úteis contribuições de código, documentação, tradução, acessibilidade e testes reproduzíveis.

## Antes de começar

Consulte issues, [downloads](docs/downloads.pt-PT.md), [roadmap](docs/roadmap-public.md) e o guia da plataforma. O trabalho Windows parte da `main`. Coordene Linux/Nigor com o [PR #5](https://github.com/MatrixChill/cybersafe-assistant/pull/5) e a branch existente para evitar duplicação.

O código original usa a [MIT aprovada pelo titular](LICENSE). Terceiros conservam os seus termos. Reveja a [proveniência](docs/licensing.md) antes de acrescentar dependências, regras, dados ou assets. Não se introduz um acordo adicional de cessão de direitos.

## Reproduzir e comunicar

Use o [formulário de erro](https://github.com/MatrixChill/cybersafe-assistant/issues/new?template=bug-report.yml) ou de [sugestão](https://github.com/MatrixChill/cybersafe-assistant/issues/new?template=feature-request.yml). Indique Windows, Arch genérico ou Nigor, versões do produto/pacote, ambiente e resultados observados.

Use ficheiros benignos descartáveis e perfil isolado. Não anexe credenciais, bases privadas, conteúdos de quarentena ou malware. Instalação, terminação de processos e testes privilegiados exigem ambiente descartável autorizado. Consulte [SECURITY.md](SECURITY.md) antes de partilhar detalhes de vulnerabilidades.

## Pull requests

1. Preserve trabalho alheio e delimite a alteração.
2. Explique problema e comportamento resultante. Distinga medições de inferências.
3. Siga o [guia de desenvolvimento](docs/development.pt-PT.md), execute verificações adequadas e registe resultados, skips e aceitação manual pendente.
4. Verifique links, traduções, proveniência de imagens e versões. Acrescente regressões de comportamento quando necessário.
5. Reveja segredos, caminhos privados, ficheiros gerados grandes e alterações indevidas. Execute `git diff --check`.
6. Abra o PR para revisão. CI aprovada não autoriza merge, freeze ou publicação.

Preserve veredictos, consentimento e gates. Assinatura, confiança, packaging e IPC exigem revisão explícita. Aprovações de freeze vinculam inventários exatos. Reveja o trabalho assistido por IA e identifique a assistência relevante no PR.

Não há SLA de suporte. Consulte [suporte](docs/support.md) para comunicar diagnóstico com segurança.
