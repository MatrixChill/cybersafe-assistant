# Outreach kit — owner review required

Drafts for review, **not posted**. Verify the current version, links and community rules again before using them. No paid/bought stars, repeated cross-posting, unsolicited direct messages or unsupported security claims. Ask for specific feedback rather than votes. The missing approved project license must not be hidden behind an “open source” label.

## Channels and eligibility (checked 2026-11-11)

| Channel | Appropriate next action |
|---|---|
| LinkedIn | Owner can adapt the EN/PT drafts below, disclose academic origin and link the real release. Review current platform and group rules before posting. |
| r/opensource | **Do not submit these drafts.** Its rules require an OSI-listed LICENSE and prohibit AI-generated content. CyberSafe has no approved root license text. Human rewriting is not presented as a way around the rule. [Community rules](https://www.reddit.com/r/opensource/). |
| r/SideProject | A possible venue to request feedback, not a verified permission to post. The public page describes project sharing, but a complete rule set was not retrievable in this review. Check [the current community](https://www.reddit.com/r/SideProject/) and ask moderators about promotion and AI-assisted drafts before submitting anything. |
| GitHub Discussions | Disabled for this repository at review. Keep the proposed welcome topic below ready; do not announce a discussion space that does not exist. Enabling it and moderating it need an owner decision. |
| Local developer/student communities | Obtain the organizer's permission and use the requested showcase channel. State your affiliation; do not treat all programming/security communities as advertising venues. |

These are scoped observations, not blanket permission from any platform. No external message was sent.

## LinkedIn — English draft

I built CyberSafe Assistant as my Prova de Aptidão Profissional (PAP), bringing multi-engine file analysis, system diagnostics and a contextual assistant into a Windows desktop app.

The interesting challenge was connecting React/Electron, a background service and native C++ while keeping failed or incomplete analysis visible. CyberSafe combines ClamAV, YARA rules, known hashes and native signals; MATRIX helps explain available process context.

The public Windows release is v0.2.4. It is an academic tool, not a Defender replacement. The installer is not Authenticode-signed, assisted update installation remains disabled, and monitoring coverage has known limits. Project licensing still needs clarification.

I'd welcome feedback on the installation guide and whether the scan results make those limits understandable.

Project: https://github.com/MatrixChill/cybersafe-assistant
Download and release notes: https://github.com/MatrixChill/cybersafe-assistant/releases/latest

## LinkedIn — rascunho PT-PT

Desenvolvi o CyberSafe Assistant no âmbito da minha Prova de Aptidão Profissional. A aplicação Windows reúne análise de ficheiros com vários motores, diagnóstico do sistema e o assistente contextual MATRIX.

O desafio foi ligar React/Electron, um serviço de fundo e componentes C++, mantendo visíveis as falhas e os resultados inconclusivos. ClamAV, regras YARA, hashes conhecidos e sinais nativos contribuem com tipos de análise diferentes.

A versão pública é a v0.2.4. É um projeto académico e não substitui o Microsoft Defender. O instalador não tem Authenticode, a instalação assistida de atualizações permanece desativada e a monitorização tem limites de cobertura. A licença global ainda precisa de clarificação.

Gostaria de receber sugestões sobre a clareza das instruções de instalação e dos resultados de análise.

Projeto: https://github.com/MatrixChill/cybersafe-assistant
Download e notas: https://github.com/MatrixChill/cybersafe-assistant/releases/latest

## Developer community / Reddit candidate — only after rules and moderator clearance

**Title:** Feedback wanted: a Windows multi-engine scanner and diagnostics project built for my PAP

I'm the creator of CyberSafe Assistant, an academic Windows app combining ClamAV, YARA, a hash database and native C++ signals with a React/Electron interface. It also includes scan history, quarantine, process diagnostics and MATRIX explanations.

I'd like feedback on one thing: can a first-time reader understand which results are conclusive and which are incomplete? The README includes real historical screenshots, explicitly labelled v0.2.0, while the current release is v0.2.4.

Important limits: no Authenticode, no assisted production installation, incomplete monitoring coverage, and an unresolved root-license declaration. Keep Defender enabled. I am not claiming certified protection or asking for stars.

README: https://github.com/MatrixChill/cybersafe-assistant

**PT-PT alternative title:** Sugestões para um projeto PAP Windows: análise multimotor e diagnóstico

Sou o criador do CyberSafe Assistant, um projeto académico que reúne ClamAV, YARA, hashes e sinais C++ numa interface Electron/React. Procuro sugestões sobre a clareza dos resultados inconclusivos e da documentação. A versão atual é a v0.2.4; as capturas históricas estão identificadas. Não substitui o Defender, não tem Authenticode e a licença global está por clarificar. Projeto: https://github.com/MatrixChill/cybersafe-assistant

## Proposed GitHub welcome discussion — not created

**Title:** Welcome — what would make CyberSafe easier to evaluate?

Share the version and the part of the documentation or interface you found difficult. English and Portuguese are welcome. For reproducible bugs, use an issue; for vulnerabilities, follow SECURITY.md and keep details private. We particularly welcome documentation review, accessibility observations and benign reproduction steps. See CONTRIBUTING.md and licensing status before substantial code submissions.

## Practical launch sequence

1. Review and merge the documentation PR only when approved; confirm rendered images and release links.
2. Resolve licensing before describing CyberSafe as OSI-licensed or posting to license-gated communities.
3. Record the [real demo](demo.md); review privacy and version labels.
4. Choose one permitted channel, adapt the copy accurately and answer feedback there. Do not mass-post.
5. Turn concrete feedback into issues. Track useful reports and documentation improvements, not promised star/download growth.
