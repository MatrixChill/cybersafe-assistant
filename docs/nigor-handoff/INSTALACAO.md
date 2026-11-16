# Instalar e testar (Arch / Nigor OS)

Como utilizador normal, numa sessão gráfica. Nunca como root, nunca com `--no-sandbox`.

```bash
# 1. Verificar o ficheiro descarregado da pré-release
sha256sum -c SHA256SUMS.txt
# 2. Instalar (o pacman pede a autorização normal)
sudo pacman -U ./cybersafe-assistant-linux-lite-0.2.4-3-x86_64.pkg.tar.zst
# 3. Dependências e motores
cybersafe-linux-diagnose | python -m json.tool
# se faltar algo, o diagnóstico indica o comando exato, p. ex.:
cybersafe-linux-diagnose --install clamav yara --consent   # pkexec pacman -S --needed …
sudo freshclam                                             # bases oficiais ClamAV
# 4. Abrir a aplicação uma vez (cria a credencial privada do perfil)
cybersafe-assistant-linux-lite
# 5. Estado para a barra
cybersafe-nigor-status
# 6. Análise de teste com um ficheiro benigno
mkdir -p ~/cybersafe-teste && echo "ficheiro benigno" > ~/cybersafe-teste/a.txt
cybersafe-nigor-status scan --consent "$HOME/cybersafe-teste"
cybersafe-nigor-status            # o resultado aparece em latestScan/history
# 7. Atualizações
cybersafe-linux-update check
```

Serviço opcional em segundo plano (com a aplicação fechada):

```bash
systemctl --user daemon-reload
systemctl --user start cybersafe-linux.service
journalctl --user -u cybersafe-linux.service
```

Reverter: `systemctl --user disable --now cybersafe-linux.service` (se ativado) e
`sudo pacman -R cybersafe-assistant-linux-lite`. O perfil em
`~/.config/cybersafe-assistant-linux-lite` não é apagado pelo pacman.
