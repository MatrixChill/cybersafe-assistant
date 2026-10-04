#!/usr/bin/env python3
"""
maestro.py - verificacao mecanica leve do ambiente Maestri.
Infraestrutura ONLY. Nao toca no source do produto. Sem deps externas.

Subcomandos:
  packet-validate <packet.json>   valida um Task Packet (skills, gates)
  ownership-check  <scope> <writer>   exit 1 se scope ja tem writer ativo diferente
  ownership-claim  <task.json>    regista/reserva ownership
  ownership-transfer <task> <new_writer> <reason>
  ownership-show
  route <packet.json>             routing deterministico por tipo de tarefa
  state-write / state-show        estado operacional machine-readable
  git-sync                       recalcula branch/ahead/behind/dirty + security preflight
  organizer-check                IN_SYNC ou DRIFT entre o organizador (fonte) e o espelho
  report-status                  estado do relatorio PAP (read-only: path/hash/lock/valid)
  report-open                    abre o DOCX LIVE no Word, pelo caminho normal
  health                          observabilidade de presenca (sob demanda)

Estados permitidos: REGISTERED CONNECTED IDLE WORKING BLOCKED RATE_LIMITED PARKED DEAD EXTERNAL_READY
Regra dura: WORKING so com evidencia (output do terminal mudou face ao ultimo snapshot).
"""
import json, os, re, subprocess, sys, hashlib, datetime, glob, fnmatch

SKILLS_DIR = os.path.expanduser("~/.agents/skills")
STATE_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "state")
OWNERSHIP = os.path.join(STATE_DIR, "ownership.json")
STATE_JSON = os.path.join(STATE_DIR, "maestro-state.json")
HEALTH_SNAP = os.path.join(STATE_DIR, "health.json")

MAX_SKILLS = 4
MIN_SKILLS = 2
DELIVERY = ("NATIVE", "MAESTRO_INJECTION")
FALSEY = ("NO", "PENDING", "", "UNKNOWN", "TBD", "N/A", "NONE", False, None)

MAX_ALLOWED_SECTIONS = 12          # seccoes injetadas por packet
REPO = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".."))
MAX_HANDOFF_LINES = 40             # handoff da Luna


def now():
    return datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def load(path, default=None):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return default if default is not None else {}


def save(path, data):
    """Escrita atómica: temp -> validar -> replace. Nao deixa estado pela metade."""
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8", newline="\n") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
        f.write("\n")
        f.flush()
        os.fsync(f.fileno())
    with open(tmp, encoding="utf-8") as f:          # validacao antes de substituir
        json.load(f)
    os.replace(tmp, path)


def truthy(v):
    return not (v is False or v is None or (isinstance(v, str) and v.strip().upper() in FALSEY))


def skill_exists(name):
    return os.path.isfile(os.path.join(SKILLS_DIR, name.strip(), "SKILL.md"))


# ---------------------------------------------------------------- P1 packet
REQUIRED_FIELDS = ["TASK", "WRITER", "SCOPE", "REQUIRED_SKILLS", "SKILLS_DELIVERY",
                   "SKILLS_LOADED", "START_ALLOWED", "ACCEPTANCE", "TESTS"]
DONE_FIELDS = ["VERIFICATION_EVIDENCE", "DONE_ALLOWED"]


def packet_validate(path):
    p = load(path)
    errs, warns = [], []
    if not p:
        print("PACKET_INVALID: ficheiro vazio ou ilegivel: %s" % path)
        return 2
    for f in REQUIRED_FIELDS + DONE_FIELDS:
        if f not in p:
            errs.append("campo em falta: %s" % f)

    req = p.get("REQUIRED_SKILLS") or []
    if not isinstance(req, list):
        req = [req]
    req = [str(s).strip() for s in req if str(s).strip()]
    for s in req:
        if not skill_exists(s):
            errs.append("REQUIRED_SKILLS referencia skill inexistente: %s" % s)
    if len(req) > MAX_SKILLS:
        errs.append("REQUIRED_SKILLS = %d skills (maximo normal %d)" % (len(req), MAX_SKILLS))
    elif len(req) < MIN_SKILLS:
        warns.append("REQUIRED_SKILLS = %d (normal e 2-3)" % len(req))

    delivery = p.get("SKILLS_DELIVERY")
    if truthy(p.get("START_ALLOWED")):
        if delivery not in DELIVERY:
            errs.append("START_ALLOWED=YES exige SKILLS_DELIVERY em %s (agora: %r)" % (list(DELIVERY), delivery))
        if not truthy(p.get("SKILLS_LOADED")):
            errs.append("START_ALLOWED=YES exige SKILLS_LOADED com evidencia (native load ou injecao real)")
        if delivery == "MAESTRO_INJECTION":
            inj = p.get("INJECTED_SECTIONS") or {}
            missing = [s for s in req if not inj.get(s)]
            if missing:
                errs.append("MAESTRO_INJECTION sem INJECTED_SECTIONS para: %s" % ", ".join(missing))
            if len(inj) > MAX_ALLOWED_SECTIONS:
                errs.append("injecao demasiado grande (%d secoes): violates context economy" % len(inj))

    if truthy(p.get("DONE_ALLOWED")):
        if not truthy(p.get("VERIFICATION_EVIDENCE")):
            errs.append("DONE_ALLOWED=YES exige VERIFICATION_EVIDENCE real (comandos + resultados)")
    if truthy(p.get("TESTS")) is False and truthy(p.get("DONE_ALLOWED")):
        errs.append("DONE_ALLOWED=YES com TESTS vazio")

    if truthy(p.get("REVIEWER")) and str(p.get("REVIEWER")) == str(p.get("WRITER")):
        warns.append("REVIEWER == WRITER: reviewer deve ser read-only e distinto")
    # P12: regras adicionais de coerencia
    writer = str(p.get("WRITER") or "")
    if writer in PARKED_AGENTS:
        errs.append("WRITER esta PARKED (%s): nao recebe task sem reavaliacao do Maestro" % writer)
    if "luna" in writer.lower() and str(p.get("SKILLS_DELIVERY", "")).upper() != "EXTERNAL":
        warns.append("writer externo (Luna): SKILLS_DELIVERY deveria ser EXTERNAL")
    if not truthy(p.get("LUNA_CANDIDATE")) and str(p.get("TYPE", "")).startswith("long_context"):
        errs.append("TYPE long_context exige LUNA_CANDIDATE avaliado explicitamente")
    ts = str(p.get("CREATED_AT") or "")
    if ts and not re.match(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$", ts):
        errs.append("CREATED_AT nao e ISO-8601 UTC: %r" % ts)
    if not ts:
        warns.append("sem CREATED_AT (timestamp recomendado)")
    for w in warns:
        print("WARN: %s" % w)
    if errs:
        for e in errs:
            print("ERROR: %s" % e)
        print("PACKET_INVALID: START_ALLOWED=%s DONE_ALLOWED=%s" % (
            p.get("START_ALLOWED"), p.get("DONE_ALLOWED")))
        return 1
    print("PACKET_VALID: task=%s writer=%s skills=%d delivery=%s start=%s done=%s" % (
        p.get("TASK"), p.get("WRITER"), len(req), delivery, p.get("START_ALLOWED"), p.get("DONE_ALLOWED")))
    return 0


# ------------------------------------------------------------ P2 ownership
ACTIVE = ("CLAIMED", "WORKING", "IN_REVIEW")


def ownership_show():
    print(json.dumps(load(OWNERSHIP, {"tasks": []}), ensure_ascii=False, indent=2))


def norm_scope(s):
    """Normaliza scope: slashes, case (Windows), ./.., separadores finais."""
    if not s:
        return ""
    t = str(s).strip().replace("\\", "/").lower()
    while "//" in t:
        t = t.replace("//", "/")
    parts = []
    for seg in t.split("/"):
        if seg in ("", "."):
            continue
        if seg == ".." and parts:
            parts.pop()
            continue
        parts.append(seg)
    return "/".join(parts)


def scopes_overlap(a, b):
    """Sobreposicao basica: um contem o outro, ou o mesmo ficheiro dentro do scope."""
    na, nb = norm_scope(a), norm_scope(b)
    if not na or not nb:
        return False
    if na == nb:
        return True
    if na.startswith(nb + "/") or nb.startswith(na + "/"):
        return True
    return False


def ownership_check(scope, writer, reassign=False):
    data = load(OWNERSHIP, {"tasks": []})
    for t in data.get("tasks", []):
        if t.get("status") in ACTIVE and scopes_overlap(t.get("scope"), scope):
            if t.get("writer") != writer:
                print("CONFLITO: scope '%s' tem writer ativo %s (task=%s, status=%s). REASSIGN explicito do Maestro ou escolher outro scope."
                      % (scope, t.get("writer"), t.get("task"), t.get("status")))
                return 1
            if norm_scope(t.get("scope")) == norm_scope(scope):
                print("OK: scope '%s' pertence a %s (mesmo writer, sem conflito)" % (scope, writer))
                return 0
    print("OK: scope '%s' livre" % scope)
    return 0


def ownership_claim(path):
    t = load(path)
    for k in ("task", "scope", "writer"):
        if not t.get(k):
            print("ERROR: ownership exige %s" % k)
            return 2
    data = load(OWNERSHIP, {"tasks": []})
    tasks = [x for x in data.get("tasks", [])
             if not (x.get("status") in ACTIVE and scopes_overlap(x.get("scope"), t["scope"]))]
    for x in data.get("tasks", []):
        if x.get("status") in ACTIVE and scopes_overlap(x.get("scope"), t["scope"]) and x.get("writer") != t["writer"]:
            print("CONFLITO: scope '%s' ativo com writer %s. USE ownership-transfer." % (t["scope"], x["writer"]))
            return 1
    entry = {"task": t["task"], "scope": t["scope"], "writer": t["writer"],
             "reviewer": t.get("reviewer", "UNASSIGNED"), "files": t.get("files", []),
             "started": t.get("started", now()), "last_activity": now(),
             "status": t.get("status", "CLAIMED")}
    tasks.append(entry)
    save(OWNERSHIP, {"tasks": tasks})
    print("OWNERSHIP_CLAIMED: %s -> writer=%s reviewer=%s scope=%s" % (entry["task"], entry["writer"], entry["reviewer"], entry["scope"]))
    return 0


def ownership_transfer(task, new_writer, reason):
    data = load(OWNERSHIP, {"tasks": []})
    hit = False
    for x in data.get("tasks", []):
        if x.get("task") == task or x.get("scope") == task:
            x["previous_writer"] = x.get("writer")
            x["writer"] = new_writer
            x["last_activity"] = now()
            x["reassigned_reason"] = reason
            hit = True
    if not hit:
        print("ERROR: task/scope nao encontrada: %s" % task)
        return 1
    save(OWNERSHIP, data)
    print("OWNERSHIP_TRANSFERRED: %s -> %s (%s)" % (task, new_writer, reason))
    return 0


# ----------------------------------------------------------------- P9 route
ROUTING = {
    "bug_windows":      ("Kilo Builder", ["systematic-debugging", "verification-before-completion"], "cybersafe-windows-native"),
    "bug_ui":           ("Qoder", ["systematic-debugging", "react-best-practices"], "cybersafe-design-system"),
    "electron_ipc":     ("Kilo Builder", ["electron-best-practices", "cybersafe-ipc-contract"], "verification-before-completion"),
    "security_review":  ("Antigravity", ["secpriv", "verification-before-completion"], "skill-security-review"),
    "long_context":     ("Luna External", ["context-optimization", "context-compression"], "context-compression"),
    "delivery":         ("OpenCode", ["cybersafe-delivery", "verification-before-completion"], "verification-before-completion"),
    "hard_p0":          ("Codex Lead", ["secpriv", "systematic-debugging"], "verification-before-completion"),
}


# ------------------------------------------------- P17/P18/P19 routing evals
COST_CLASS = {"Shell": "FREE_LOCAL", "Continue Worker": "FREE_LOCAL", "Luna External": "EXTERNAL_FREE",
              "kiro": "LOW_COST_CLOUD", "Aider Worker": "FREE_LOCAL", "Goose Worker": "FREE_LOCAL",
              "Crush Reviewer": "NORMAL_CLOUD", "OpenCode": "NORMAL_CLOUD", "qoder": "NORMAL_CLOUD",
              "Kilo Builder": "NORMAL_CLOUD", "Codex Lead": "PREMIUM", "Antigravity": "PREMIUM"}
FAILOVER = {
    "qoder": [("kiro", "frontend pequeno/medio"), ("OpenCode", "integracao frontend maior")],
    "Kilo Builder": [("OpenCode", "backend/IPC"), ("Codex Lead", "so se complexidade justificar")],
    "OpenCode": [("Freebuff Builder", "integracao"), ("Kilo Builder", "se for nativo")],
    "kiro": [("OpenCode", "default")],
    "Shell": [("Freebuff Builder", "repetir o comando manualmente")],
    "Codex Lead": [("Antigravity", "arquitectura read-only"), ("Kilo Builder", "se for Windows/IPC")],
    "Antigravity": [("OpenCode", "review de 2a opiniao")],
    "Luna External": [("Continue Worker", "leitura local longa"), ("Freebuff Builder", "leitura direta")],
}
# scenario -> (writer, reviewer, skills, luna, premium, why)
ROUTING_EVALS = [
    ("A Windows process tombstone bug", "Kilo Builder", "OpenCode",
     ["systematic-debugging", "cybersafe-windows-native", "verification-before-completion"], "NO", "NO",
     "causa-so no SO: medicao pelo SO e patch Windows/IPC sao do Kilo; review de codigo pelo OpenCode"),
    ("B React dashboard com render loop", "qoder", "OpenCode",
     ["react-best-practices", "systematic-debugging", "verification-before-completion"], "NO", "NO",
     "comportamento React e estado: qoder; TDD so se a correccao mexer em logica testavel"),
    ("C Electron IPC timeout", "Kilo Builder", "OpenCode",
     ["electron-best-practices", "cybersafe-ipc-contract", "systematic-debugging"], "NO", "NO",
     "fronteira main/preload e contrato IPC: Kilo; review de contrato pelo OpenCode"),
    ("D Security review de local API", "Antigravity", "Codex Lead",
     ["secpriv", "verification-before-completion"], "NO", "YES (read-only, sem escrita)",
     "review de seguranca: Antigravity read-only; Codex so se P0 ou superficie nova"),
    ("E UI inconsistente dark/light", "qoder", "qoder (auto-review ou OpenCode)",
     ["cybersafe-design-system", "impeccable", "cybersafe-ptpt-ui"], "NO", "NO",
     "tokens e identidade: design-system; craft: impeccable; copy/estados: ptpt-ui"),
    ("F relatorio/log de 10k linhas", "Luna External", "Freebuff Builder",
     ["context-optimization", "context-compression"], "YES", "NO",
     "leitura longa barata e externa; nao justifies premium nem cloud com quota"),
    ("G alteracao multi-package", "Freebuff Builder", "OpenCode",
     ["writing-plans", "executing-plans", "verification-before-completion"], "NO", "CONDICIONAL",
     "atravessa camadas: 1 writer por scope; Codex so se houver risco ou incerteza real"),
    ("H pequeno helper local", "Continue Worker", "Shell",
     ["executing-plans", "verification-before-completion"], "NO", "NO",
     "patch pequeno e local: worker local; QA mecanico e do Shell, nao de um LLM"),
]


def routing_eval():
    print("%-34s %-16s %-16s %-9s %-7s %s" % ("SCENARIO", "WRITER", "REVIEWER", "LUNA", "PREMIUM", "COST"))
    for name, w, r, sk, luna, prem, why in ROUTING_EVALS:
        cls = COST_CLASS.get(w, "?")
        print("%-34s %-16s %-16s %-9s %-7s %s" % (name, w, r, luna, prem, cls))
        print("    skills: %s" % ", ".join(sk))
        print("    why: %s" % why)
        miss = [s for s in sk if not skill_exists(s)]
        out = route_agent_ok(w, sk)
        if miss:
            print("    PROBLEMA: skills inexistentes %s" % miss)
        if out:
            print("    PERFIL: %s" % "; ".join(out))
    print("\nFAILOVER (max 2 por agente, sem cadeia):")
    for a, chain in FAILOVER.items():
        print("  %-14s -> %s" % (a, ", ".join("%s (%s)" % c for c in chain)))
    return 0


OPENCODE_CFG = os.path.expanduser("~/.config/opencode/opencode.json")
GIT_SYNC_MODE = "PREPARE_ONLY"      # nunca add/commit/push automatico
# Nomes de ficheiro que indicam segredo. Deliberadamente ANCORADO no nome do
# ficheiro: um `.*token.*` sem ancora marcava `design-semantic-tokens.test.ts`
# como segredo. Um gate de segurança que dá falsos positivos ensina a ignorar o
# gate, e esse e o pior resultado possivel para uma barreira de seguranca.
# Um ficheiro chamado `token.test.ts` e codigo de teste, nao uma credencial.
SECRET_FILENAMES = (
    r"\.env(\..*)?|id_rsa|id_ed25519|\.npmrc|credentials(\.json)?|"
    r"secrets?\.(ya?ml|json)|"
    # chaves e certificados deAssinatura, pela extensao (ancorada no fim)
    r".*\.(pem|p12|pfx|key|keystore|jks)|"
    # credenciais pelo nome INTEIRO do ficheiro, nao por subtexto
    r"(token|tokens|apikey|api_key|api-key|password|passwd|secret|secrets|"
    r"credential|credentials|auth)\.(ya?ml|json|env|txt|ini|cfg|conf|xml)"
)
SECRET_PAT = re.compile(r"(^|/)(" + SECRET_FILENAMES + r")$", re.I)
BIG_BYTES = 5 * 1024 * 1024
BUILD_PAT = re.compile(r"(^|/)(dist|build|out|coverage|\.next|\.cache|node_modules|release)(/|$)|"
                       r"\.(log|tmp|bak|old|zip|7z|exe|dll|dmg|msi)$", re.I)


def git(*args, repo=None):
    try:
        r = subprocess.run(["git"] + list(args), cwd=repo or REPO, capture_output=True, text=True,
                           encoding="utf-8", errors="replace", timeout=30)
        return r.returncode, r.stdout.strip()
    except Exception:
        return 1, ""


def classify_sync(branch, upstream, ahead, behind, dirty):
    if not branch:
        return "REMOTE_UNAVAILABLE"
    if not upstream:
        return "NO_UPSTREAM"
    if ahead and behind:
        return "DIVERGED"
    if ahead:
        return "CLEAN_AHEAD"
    if dirty:
        return "DIRTY_LOCAL"
    return "CLEAN_SYNCED"


def commit_plan(dirty_files):
    # Ficheiros de produto que vivem FORA de packages/ e definitions/.
    ROOT_PACKAGE_FILES = {"package.json", "package-lock.json", "tsconfig.json"}
    groups = {"maestri-infra": [], "docs": [], "product": [], "pap-report": [], "scratch-temp": []}
    for f in dirty_files:
        # O git core.quotepath QUOTA paths com espacos/acentos: o caminho real
        # chega como "docs/relatorio PAP/Relatorio_....docx", com aspas dentro.
        # Sem tirar essas aspas, `p.startswith("docs/")` falha e o relatorio PAP
        # — que e source of truth do workstream — caia em scratch-temp.
        p = f.replace("\\", "/")
        if len(p) > 1 and p[0] == '"' and p[-1] == '"':
            p = p[1:-1]
        if p.startswith(".maestri/"):
            groups["maestri-infra"].append(p)
        elif p.startswith("docs/relatorio PAP/"):
            # O DOCX/PDF do relatorio e fonte do PAP Delivery, nao rascunho.
            groups["pap-report"].append(p)
        elif p.startswith("docs/") or p.endswith(".md"):
            groups["docs"].append(p)
        elif (p.startswith("packages/") or p.startswith("definitions/")
              or p in ROOT_PACKAGE_FILES or p.startswith("scripts/")):
            # scripts/ e o package.json da raiz sao produto: um script de teste
            # ou uma verificacao de identidade de processo nao e rascunho.
            # Sem esta regra, um `npm run test:native` novo no package.json
            # ficava de fora do commit de produto — o gate de build executa
            # exactamente essa linha.
            groups["product"].append(p)
        else:
            groups["scratch-temp"].append(p)
    out = []
    for name, fs in groups.items():
        if fs:
            out.append("  %s: %d ficheiro(s) [%s]" % (name, len(fs), ", ".join(fs[:6]) + (" ..." if len(fs) > 6 else "")))
    return out


def git_sync(write_state=True):
    rc, branch = git("rev-parse", "--abbrev-ref", "HEAD")
    branch = branch if rc == 0 and branch else ""
    rc, up = git("rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}")
    upstream = up if rc == 0 else ""
    rc, head = git("rev-parse", "--short", "HEAD")
    head = head if rc == 0 else ""
    ahead = behind = 0
    remote_head = ""
    if upstream:
        rc, a = git("rev-list", "--count", "%s..HEAD" % upstream)
        ahead = int(a) if rc == 0 and a.isdigit() else 0
        rc, b = git("rev-list", "--count", "HEAD..%s" % upstream)
        behind = int(b) if rc == 0 and b.isdigit() else 0
        rc2, rh = git("rev-parse", "--short", upstream)
        remote_head = rh if rc2 == 0 else ""
    rc, po = git("status", "--porcelain")
    staged, modified, untracked = [], [], []
    for l in po.splitlines():
        xy, path = l[:2], l[3:]
        if l.startswith("??"):
            untracked.append(path.strip())
            continue
        if xy[0] not in (" ", "?"):
            staged.append(path)
        if xy[1] not in (" ", "?"):
            modified.append(path)
    dirty = sorted(set(staged) | set(modified) | set(untracked))
    state = classify_sync(branch, upstream, ahead, behind, len(dirty))

    # security preflight (read-only): segredos, binarios grandes, artefactos
    findings = []
    for f in dirty:
        fp = os.path.join(REPO, f.replace("/", os.sep))
        if SECRET_PAT.search(f):
            findings.append("SECRET? %s" % f)
        elif BUILD_PAT.search(f):
            findings.append("ARTEFACTO/BUILD? %s" % f)
        elif os.path.isfile(fp) and os.path.getsize(fp) > BIG_BYTES:
            findings.append("FICHEIRO GRANDE %.1fMB %s" % (os.path.getsize(fp) / 1048576.0, f))
    rc, dc = git("diff", "--check")
    diff_check = "clean" if rc == 0 else "PROBLEMAS: %s" % dc.splitlines()[:2]

    sync_ready = "YES" if (upstream and not findings and diff_check == "clean") else "NO"
    rec = {
        "CLEAN_SYNCED": "nada a fazer",
        "CLEAN_AHEAD": "LOCAL AHEAD - GITHUB UPDATE RECOMMENDED (commit agrupado + push so com autorizacao)",
        "DIRTY_LOCAL": "COMMIT_PLAN pronto; executar apenas com autorizacao explicita",
        "DIVERGED": "DIVERGED - DO NOT AUTO MERGE: rever remoto antes de continuar",
        "NO_UPSTREAM": "definir upstream antes de qualquer sync",
        "REMOTE_UNAVAILABLE": "repo git invalido",
    }[state]

    print("BRANCH = %s" % (branch or "?"))
    print("UPSTREAM = %s" % (upstream or "(none)"))
    print("LOCAL_HEAD = %s" % (head or "?"))
    print("REMOTE_HEAD_KNOWN = %s" % (remote_head or "(nenhum)"))
    print("AHEAD = %d" % ahead)
    print("BEHIND = %d" % behind)
    print("DIRTY = %d (staged %d, modified %d, untracked %d)" % (len(dirty), len(staged), len(modified), len(untracked)))
    print("SYNC_STATE = %s" % state)
    print("SYNC_MODE = %s (nunca add/commit/push automatico)" % GIT_SYNC_MODE)
    print("DIFF_CHECK = %s" % diff_check)
    print("SECURITY_PREFLIGHT = %s" % ("limpo" if not findings else "; ".join(findings)))
    print("SYNC_READY = %s" % sync_ready)
    print("SYNC_RECOMMENDATION = %s" % rec)
    print("COMMIT_PLAN (PROPOSTA, nao execucao):")
    for line in commit_plan(dirty) or ["  (sem alteracoes)"]:
        print(line)
    if write_state:
        st = load(STATE_JSON)
        st["git"] = {"branch": branch, "head": head, "upstream": upstream, "ahead": ahead,
                     "behind": behind, "dirty": len(dirty), "syncState": state,
                     "syncReady": sync_ready, "securityPreflight": findings,
                     "lastChecked": now()}
        save(STATE_JSON, st)
    return state


ORGANIZER_HTML = os.path.join(REPO, "docs", "cybersafe-organizador-pap-v2-editavel.html")
ORGANIZER_MD = os.path.join(REPO, "docs", "CYBERSAFE_ORGANIZADOR.md")
ORGANIZER_CHECKER = os.path.join(REPO, "output", "pap-sprint", "organizer-check.mjs")

ORGANIZER_STATUS_EMOJI = {
    "✅": "done",
    "\U0001F7E1": "progress",   # 🟡 (par substituto: a flag u é obrigatória)
    "⚪": "planned",
    "⛔": "blocked",
    "\U0001F534": "pending_manual",  # 🔴 fora da legenda do organizador
}


def _organizer_html_tasks():
    """Extrai o array `sections` do HTML. Read-only, sem executar JS do browser."""
    with open(ORGANIZER_HTML, "r", encoding="utf-8") as fh:
        html = fh.read()
    marker = "const sections = ["
    start = html.find(marker)
    if start < 0:
        return None, None
    after = html[start + len(marker) - 1:]
    depth = 0
    end = -1
    quote = None
    i = 0
    while i < len(after):
        c = after[i]
        if quote:
            if c == "\\":
                i += 2
                continue
            if c == quote:
                quote = None
            i += 1
            continue
        if c in "\"'`":
            quote = c
        elif c in "[{(":
            depth += 1
        elif c in "]})":
            depth -= 1
            if depth == 0:
                end = i
                break
        i += 1
    if end < 0:
        return None, None
    src = after[: end + 1]
    # Transpilar o object literal para dicts sem depender de exec de JS.
    tasks = {}
    for m in re.finditer(r"\{id:'([^']+)'\s*,\s*label:'((?:[^'\\]|\\.)*)'\s*,\s*status:'([^']+)'", src):
        tasks[m.group(1)] = {"label": m.group(2), "status": m.group(3)}
    ver = re.search(r"const DATA_VERSION = '([^']+)'", html)
    return tasks, (ver.group(1) if ver else "UNKNOWN")


def _organizer_md_tasks():
    with open(ORGANIZER_MD, "r", encoding="utf-8") as fh:
        lines = fh.read().splitlines()
    tasks = {}
    unparsed = []
    item_re = re.compile(r"^-\s+(\S+)\s+`([^`]+)`\s+—\s*([\s\S]*)$", re.UNICODE)
    for line in lines:
        if not re.match(r"^-\s+", line):
            continue
        m = item_re.match(line)
        if not m:
            unparsed.append(line[:120])
            continue
        emoji, tid = m.group(1), m.group(2)
        tasks[tid] = {"label": m.group(3), "status": ORGANIZER_STATUS_EMOJI.get(emoji, "UNKNOWN")}
    return tasks, unparsed


def _organizer_header_counts(lines):
    for l in lines:
        m = re.match(r"^\|\s*Tarefas\s*\|\s*\*\*(\d+)\*\*\s*=\s*(\d+) concluídas\s*\+\s*(\d+) em curso\s*\+\s*(\d+) planeadas\s*\+\s*(\d+) bloqueadas\s*\|", l)
        if m:
            return {"total": int(m.group(1)), "done": int(m.group(2)),
                    "progress": int(m.group(3)), "planned": int(m.group(4)),
                    "blocked": int(m.group(5))}
    return None


def organizer_check():
    pass  # substituido abaixo


def _report_paths():
    d = os.path.join(REPO, "docs", "relatorio PAP")
    return {
        "live": os.path.join(d, "Relatorio_PAP_CyberSafe_LIVE.docx"),
        "baseline_docx": os.path.join(d, "Relatorio_PAP_CyberSafe_v9_REVISTA_04-10-2026 (1).docx"),
        "baseline_pdf": os.path.join(d, "Relatorio_PAP_CyberSafe_v9_REVISTA_04-10-2026.pdf"),
        "snapshot_pdf": os.path.join(d, "Relatorio_PAP_CyberSafe_LIVE_PREVIEW.pdf"),
        "changelog": os.path.join(d, "PAP_REPORT_CHANGELOG.md"),
    }


def report_word_lock(path=None):
    """O Word cria `~$<nome>.docx` ao lado do ficheiro enquanto o tem aberto.
    A sua presenca significa: alguem tem o documento aberto no Word. Nunca
    escrever por fora nessa situacao — corromper o relatorio para parecer
    'live' e pior do que estar atrasado."""
    target = path or _report_paths()["live"]
    d, name = os.path.dirname(target), os.path.basename(target)
    lock = os.path.join(d, "~$" + name)
    return (lock, os.path.exists(lock))


def report_docx_valid(path=None):
    """Valida o ZIP do DOCX e o word/document.xml sem dependencias externas.
    Espelha o que o validador Node mede, para o gate nao depender do Node."""
    target = path or _report_paths()["live"]
    if not os.path.isfile(target):
        return False, "ficheiro inexistente: %s" % target
    try:
        import zipfile
    except ImportError:
        return None, "zipfile indisponivel (UNKNOWN, nao assumido como valido)"
    try:
        if not zipfile.is_zipfile(target):
            return False, "nao e um ZIP valido"
        with zipfile.ZipFile(target) as z:
            bad = z.testzip()
            if bad:
                return False, "entrada corrompida no ZIP: %s" % bad
            names = z.namelist()
            if "word/document.xml" not in names:
                return False, "word/document.xml ausente"
            xml = z.read("word/document.xml").decode("utf-8", "replace")
            # `w:p` tem de entrar na lista: um `<w:p>` por fechar é a corrupção
            # mais provável de uma edição cirúrgica mal feita, e não a apanhar
            # daria um "DOCX válido" falso — o pior resultado de um gate.
            for tag in ("w:body", "w:p", "w:tbl", "w:tc"):
                o = len(re.findall(r"<%s[\s>]" % tag, xml))
                c = len(re.findall(r"</%s>" % tag, xml))
                if o != c:
                    return False, "tags desbalanceadas: %s (%d abre / %d fecha)" % (tag, o, c)
            if len(re.findall(r"<w:p[\s>]", xml)) < 10:
                return False, "poucos paragrafos: documento provavelmente truncado"
        return True, "ZIP valido, word/document.xml presente e balanceado"
    except Exception as e:      # noqa: BLE001 - o gate tem de reportar, nunca crashar
        return False, "erro a ler o DOCX: %s" % e


def report_last_event():
    """ULTIMO evento registado no changelog (read-only).

    Varre o ficheiro e devolve a ultima entrada completa — devolver a primeira
    seria mostrar o estado mais antigo como se fosse o actual."""
    cl = _report_paths()["changelog"]
    if not os.path.isfile(cl):
        return "UNKNOWN (sem changelog)"
    try:
        with open(cl, "r", encoding="utf-8") as fh:
            lines = fh.read().splitlines()
    except OSError as e:
        return "UNKNOWN (%s)" % e
    indices = [i for i, l in enumerate(lines) if l.startswith("- **DATE**")]
    if not indices:
        return "UNKNOWN (sem entradas DATE)"
    i = indices[-1]                     # a ultima, nao a primeira
    out = []
    for r in lines[i:i + 12]:
        m = re.match(r"- \*\*(DATE|WORKSTREAM|DOCX_SECTION|VERIFIED)\*\* = (.+)", r)
        if m:
            val = m.group(2).strip()
            out.append("%s=%s" % (m.group(1), val if len(val) <= 90 else val[:90] + "..."))
    return " | ".join(out) if out else "UNKNOWN"


def report_status():
    """Estado do relatorio PAP. READ-ONLY: nao escreve nada em lado nenhum."""
    p = _report_paths()
    lock_path, locked = report_word_lock()
    print("REPORT_SOURCE_OF_TRUTH = DOCX (nunca HTML, nunca PDF)")
    print("PATH = %s" % p["live"])
    if not os.path.isfile(p["live"]):
        print("SIZE = (inexistente)")
        print("DOCX_VALID = NO")
        print("WORD_LOCK = UNKNOWN")
        return 2
    st = os.stat(p["live"])
    with open(p["live"], "rb") as fh:
        digest = hashlib.sha256(fh.read()).hexdigest()
    valid, why = report_docx_valid()
    print("SIZE = %d bytes (%.1f KB)" % (st.st_size, st.st_size / 1024.0))
    print("LAST_MODIFIED = %s" % datetime.datetime.fromtimestamp(st.st_mtime).strftime("%Y-%m-%d %H:%M:%S"))
    print("HASH = sha256 %s" % digest)
    print("WORD_LOCK = %s%s" % ("YES" if locked else "NO",
                                "  (~%s existe: Word tem o documento aberto)" % os.path.basename(lock_path) if locked else ""))
    h = report_docx_handler()
    if h:
        exe = os.path.basename(h["exe"])
        ok = any(exe.lower() == e for e in EDITOR_EXES)
        print("DOCX_HANDLER = %s  (%s)" % (h["exe"], "editor" if ok else "NAO e editor: report-open vai recusar"))
    else:
        print("DOCX_HANDLER = (nenhum programa associado a .docx nesta maquina)")
    print("DOCX_VALID = %s (%s)" % ("YES" if valid else ("UNKNOWN" if valid is None else "NO"), why))
    print("REPORT_BLOCKED_BY_WORD = %s" % ("YES" if locked else "NO"))
    print("LAST_REPORT_EVENT = %s" % report_last_event())
    # integridade dos baselines: nunca podem mudar
    for key, label in (("baseline_docx", "BASELINE_DOCX"), ("baseline_pdf", "BASELINE_PDF")):
        bp = p[key]
        if os.path.isfile(bp):
            with open(bp, "rb") as fh:
                d = hashlib.sha256(fh.read()).hexdigest()
            print("%s = %s" % (label, d))
        else:
            print("%s = AUSENTE" % label)
    snap = p["snapshot_pdf"]
    print("SNAPSHOT_PDF = %s%s" % (snap if os.path.isfile(snap) else "(inexistente)",
                                  "  (EXPORT apenas; nao e fonte, nao precisa de regenerar a cada save)" if os.path.isfile(snap) else ""))
    return 0


def report_docx_handler():
    """Programa associado a `.docx` nesta maquina (Windows), ou None.

    Mede pelo registo em vez de assumir Word. MEDIDO nesta maquina: `.docx`
    esta associado ao Opera GX (navegador). Um `os.startfile` cego abriria o
    relatorio no browser e o usuario leria-o como se fosse o Word — e o
    ficheiro de 1 MBseria oferecido como download. Por isso `report_open`
    recusa-se a abrir quando o handler nao e um editor.
    """
    if sys.platform != "win32":
        return None
    import winreg
    try:
        k = winreg.OpenKey(winreg.HKEY_CLASSES_ROOT, r".docx")
        cls, _ = winreg.QueryValueEx(k, "")
    except OSError:
        return None
    if not cls:
        return None
    try:
        k2 = winreg.OpenKey(winreg.HKEY_CLASSES_ROOT, r"%s\shell\open\command" % cls)
        cmd, _ = winreg.QueryValueEx(k2, "")
    except OSError:
        return None
    # O comando registado vem como `"C:\...\Programa GX\app.exe" "%1"`.
    # Nao se pode partir no espaco: o nome da pasta pode ter espacos.
    cmd = cmd.strip()
    if cmd.startswith('"'):
        end = cmd.find('"', 1)
        exe = cmd[1:end] if end > 0 else cmd.strip('"')
    else:
        exe = cmd.split(" ", 1)[0]
    return {"prog_id": cls, "command": cmd, "exe": exe}


# Executores que servem para editar o relatorio. Um browser nao serve: nao
# edita, e abre uma descarga em vez do documento.
EDITOR_EXES = ("winword.exe", "wordpad.exe", "soffice.exe", "swriter.exe",
               "libreoffice.exe", "wps.exe", "word.exe")


def report_open():
    """Abre EXACTAMENTE o DOCX LIVE com a associacao normal do Windows.

    Sem viewer HTML, sem conversao, sem staging. Duas guardas antes de abrir:
    o lock do Word, e o facto de o handler associado ser realmente um editor.
    """
    p = _report_paths()["live"]
    lock_path, locked = report_word_lock()
    if locked:
        print("REPORT_BLOCKED_BY_WORD = YES")
        print("MOTIVO = %s existe: o Word tem o relatorio aberto." % os.path.basename(lock_path))
        print("ACCAO = nada foi aberto nem modificado. Fecha o documento no Word e repete.")
        print("REGRA = nunca escrever por fora do Word para parecer 'live'.")
        return 3
    if not os.path.isfile(p):
        print("ERRO = DOCX inexistente: %s" % p)
        return 2
    valid, why = report_docx_valid()
    if valid is not True:
        print("ERRO = o DOCX nao passou validacao: %s" % why)
        print("ACCAO = nada foi aberto. Valida antes de abrir.")
        return 2
    print("A_ABRIR = %s" % p)
    print("SIZE = %d bytes" % os.path.getsize(p))
    print("DOCX_VALID = YES (%s)" % why)
    print("WORD_LOCK = NO")
    if sys.platform != "win32":
        print("ERRO = este comando abre com a associacao do Windows; a plataforma actual e %s" % sys.platform)
        return 2
    handler = report_docx_handler()
    if handler is None:
        print("ERRO = nenhum programa associado a .docx nesta maquina.")
        print("ACCAO = nada foi aberto. Instala o Microsoft Word ou define o programa por omissao para .docx.")
        return 2
    exe_name = os.path.basename(handler["exe"]).lower()
    is_editor = any(exe_name == e for e in EDITOR_EXES)
    print("DOCX_HANDLER = %s" % handler["exe"])
    if not is_editor:
        print("ERRO = o programa associado a .docx NAO e um editor de texto (%s)." % handler["exe"])
        print("      Editores aceite: %s" % ", ".join(EDITOR_EXES))
        print("MOTIVO = abrir o relatorio num %s daria uma descarga, nao o documento." % exe_name)
        print("ACCAO = nada foi aberto. Instala o Microsoft Word OU associa .docx a um editor, e repete.")
        print("       while: 'python .maestri/tools/maestro.py report-open' depois de instalado.")
        return 4
    try:
        os.startfile(p)                      # noqa: S606 - abre o DOCX no editor associado
    except OSError as e:
        print("ERRO = falha ao abrir: %s" % e)
        return 2
    print("ABERTO = True (%s)" % handler["exe"])
    print("NOTA = depois de mexer, corre 'report-status' para confirmar LAST_MODIFIED, WORD_LOCK e DOCX_VALID.")
    return 0


def organizer_check():
    """IN_SYNC ou DRIFT entre a fonte de verdade (HTML) e o espelho (MD).
    Nunca corrige nada. So reporta. exit 0 = IN_SYNC, 1 = DRIFT, 2 = erro."""
    if not os.path.isfile(ORGANIZER_HTML):
        print("ORGANIZER_CHECK_ERROR = HTML ausente: %s" % ORGANIZER_HTML)
        return 2
    if not os.path.isfile(ORGANIZER_MD):
        print("ORGANIZER_CHECK_ERROR = MD ausente: %s" % ORGANIZER_MD)
        return 2
    html_tasks, data_version = _organizer_html_tasks()
    if html_tasks is None:
        print("ORGANIZER_CHECK_ERROR = 'const sections = [' nao encontrado no HTML")
        return 2
    md_tasks, unparsed = _organizer_md_tasks()
    with open(ORGANIZER_MD, "r", encoding="utf-8") as fh:
        header = _organizer_header_counts(fh.read().splitlines())

    html_counts = {}
    for t in html_tasks.values():
        html_counts[t["status"]] = html_counts.get(t["status"], 0) + 1
    md_counts = {}
    for t in md_tasks.values():
        md_counts[t["status"]] = md_counts.get(t["status"], 0) + 1

    only_html = sorted(set(html_tasks) - set(md_tasks))
    only_md = sorted(set(md_tasks) - set(html_tasks))
    drifts = []
    for tid in sorted(set(html_tasks) & set(md_tasks)):
        if html_tasks[tid]["status"] != md_tasks[tid]["status"]:
            drifts.append("%s: status html=%s md=%s" % (tid, html_tasks[tid]["status"], md_tasks[tid]["status"]))
    non_standard = sorted(s for s in md_counts if s not in ("done", "progress", "planned", "blocked"))
    header_mismatch = []
    if header:
        pairs = [("total", len(html_tasks)),
                 ("done", html_counts.get("done", 0)),
                 ("progress", html_counts.get("progress", 0)),
                 ("planned", html_counts.get("planned", 0)),
                 ("blocked", html_counts.get("blocked", 0))]
        for k, actual in pairs:
            if header[k] != actual:
                header_mismatch.append("%s: md=%d html=%d" % (k, header[k], actual))

    in_sync = not (only_html or only_md or drifts or unparsed or header_mismatch)
    print("ORGANIZER_CHECK = %s" % ("IN_SYNC" if in_sync else "DRIFT"))
    print("SOURCE_OF_TRUTH = docs/cybersafe-organizador-pap-v2-editavel.html (DATA_VERSION %s)" % data_version)
    print("MIRROR = docs/CYBERSAFE_ORGANIZADOR.md")
    print("TASKS_HTML = %d  TASKS_MD = %d" % (len(html_tasks), len(md_tasks)))
    print("HTML_STATUS = %s" % json.dumps(html_counts, ensure_ascii=False, sort_keys=True))
    print("MD_HEADER = %s" % json.dumps(header, ensure_ascii=False, sort_keys=True))
    if non_standard:
        print("NON_STANDARD_MD_STATUSES = %s (fora da legenda do organizador)" % ", ".join(non_standard))
    if only_html:
        print("ONLY_IN_HTML (%d) = %s" % (len(only_html), ", ".join(only_html)))
    if only_md:
        print("ONLY_IN_MD (%d) = %s" % (len(only_md), ", ".join(only_md)))
    if unparsed:
        print("MD_UNPARSED_LINES (%d) = %s" % (len(unparsed), " | ".join(unparsed[:5])))
    if header_mismatch:
        print("HEADER_MISMATCH (%d):" % len(header_mismatch))
        for h in header_mismatch:
            print("  %s" % h)
    if drifts:
        print("DRIFTS (%d):" % len(drifts))
        for d in drifts:
            print("  %s" % d)
    print("AUTO_CORRECTION = NO (este comando nunca escreve nos ficheiros)")
    print("DETALHE = output/pap-sprint/ORGANIZER_DRIFT_REPORT.md")
    return 0 if in_sync else 1


def session_checkpoint():
    print("SESSION_CHECKPOINT")
    git_sync(write_state=False)
    st = load(STATE_JSON)
    tasks = st.get("ownership", [])
    print("OPEN_TASKS = %s" % (", ".join("%s (writer=%s,status=%s)" % (t.get("task"), t.get("writer"), t.get("status")) for t in tasks) or "nenhum"))
    print("TESTS = nao executados nesta janela (infraestrutura apenas)")
    print("BLOCKERS = %s" % (", ".join(st.get("blockers", [])) or "nenhum"))
    print("LUNA = %s" % (st.get("luna", {}) or {}).get("status", "?"))
    print("AUTO_COMMIT = NO | AUTO_PUSH = NO | GITHUB_ACTION_REQUIRED = SIM (utilizador)")
    return 0


def _resolve(patterns, cmd):
    """Resolve uma policy bash do OpenCode sem executar nada.
    Semantica: padrao mais especifico (mais longo) ganha; '*' e o catch-all."""
    best = None
    for pat, act in patterns.items():
        if fnmatch.fnmatch(cmd, pat):
            if best is None or len(pat) > len(best[0]):
                best = (pat, act)
    return best or (None, "ask")


def guardrail_resolve(cmd):
    d = load(OPENCODE_CFG, {})
    pats = (d.get("permission") or {}).get("bash") or {}
    if not pats:
        print("GUARDRAIL: sem policy bash em opencode.json (POLICY ONLY)")
        return 2
    pat, act = _resolve(pats, cmd)
    print("%-42s -> %-6s (regra: %s)" % (cmd, act.upper(), pat))
    return 0 if act == "deny" else 1


def selfcheck():
    """Validacao completa, sob demanda. Sem daemon, sem escrita de produto."""
    fails = []

    r = skills_audit(write=False)
    if r != 0:
        fails.append("skills-audit")

    req17 = ["systematic-debugging", "verification-before-completion", "test-driven-development", "writing-plans",
             "executing-plans", "requesting-code-review", "context-optimization", "context-compression",
             "impeccable", "apple-design-principles", "react-best-practices", "electron-best-practices",
             "secpriv", "thinking-toolkit", "skill-security-review", "cybersafe-design-system", "cybersafe-delivery"]
    miss = [s for s in req17 if not skill_exists(s)]
    if miss:
        fails.append("capacidades em falta: %s" % miss)

    pk = os.path.join(os.path.dirname(os.path.abspath(__file__)), "packets")
    good = bad = 0
    for f in sorted(glob.glob(os.path.join(pk, "*.json"))):
        rc = packet_validate(f)
        name = os.path.basename(f)
        if name.startswith("F-"):
            if rc != 1:
                fails.append("packet invalido nao foi rejeitado: %s" % name)
        elif rc == 0:
            good += 1
        else:
            bad += 1
            fails.append("packet valido rejeitado: %s" % name)

    st = load(STATE_JSON)
    if not st.get("maestro"):
        fails.append("state.json sem maestro")
    for t in st.get("ownership", []):
        if not t.get("writer"):
            fails.append("ownership sem writer: %s" % t.get("task"))
    scopes = [t["scope"] for t in st.get("ownership", []) if t.get("status") in ACTIVE]
    if len(scopes) != len(set(scopes)):
        fails.append("scope com mais de um writer ativo")

    role_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "roles")
    for f in sorted(glob.glob(os.path.join(role_dir, "*", "role.json"))):
        try:
            o = json.load(open(f, encoding="utf-8"))
        except Exception as e:
            fails.append("role.json invalido: %s (%s)" % (os.path.basename(os.path.dirname(f)), e))
            continue
        pr = o.get("prompt") or ""
        if not pr:
            fails.append("role sem prompt: %s" % os.path.basename(os.path.dirname(f)))
        if "START HERE" in pr or "FLOW HARDENING" in pr:
            fails.append("role com referencia morta: %s" % os.path.basename(os.path.dirname(f)))

    live = {"AGENT ROLES", "MAESTRI_STATE", "CURRENT STATE V3", "skill-routing", "REGISTRY POOL",
            "ARCHITECTURE", "FILE MAP", "CRITICAL FLOWS", "TEST COMMANDS", "P0 EICAR REGRA"}

    # guardrail do OpenCode tem de resolver DENY para comandos destrutivos
    gp = load(os.path.expanduser("~/.config/opencode/opencode.json"), {})
    gb = (gp.get("permission") or {}).get("bash") or {}
    if gb:
        for cmd in ("git reset --hard HEAD", "git clean -fd", "git stash", "git push --force"):
            pat, act = _resolve(gb, cmd)
            if act != "deny":
                fails.append("guardrail nao nega: %s (regra %s -> %s)" % (cmd, pat, act))
    else:
        fails.append("opencode.json sem permission.bash (guardrail tecnico ausente)")

    # testes adversariais (16 casos) correm como regressao
    adv = os.path.join(os.path.dirname(os.path.abspath(__file__)), "adversarial.py")
    if os.path.isfile(adv):
        rc = subprocess.run([sys.executable, adv], capture_output=True, text=True,
                            encoding="utf-8", errors="replace", timeout=120).returncode
        if rc != 0:
            fails.append("adversarial.py com falhas (exit %d)" % rc)

    print("SELFCHECK: capacidades=%d/17 packets_ok=%d packets_bad=%d notes_esperadas=%d" % (
        len(req17) - len(miss), good, bad, len(live)))
    print("RESULT: %s" % ("OK" if not fails else "FALHAS: %s" % fails))
    return 0 if not fails else 1


def route(path):
    p = load(path)
    t = p.get("TYPE") or p.get("type")
    if t not in ROUTING:
        print("ROUTE_UNKNOWN: TYPE=%r (conhecidos: %s)" % (t, ", ".join(sorted(ROUTING))))
        return 2
    agent, skills, optional = ROUTING[t]
    print("TYPE=%s\n  AGENT=%s\n  REQUIRED_SKILLS=%s\n  OPTIONAL=%s" % (t, agent, skills, optional))
    for s in skills:
        print("  skill %s -> %s" % (s, "OK" if skill_exists(s) else "MISSING"))
    for w in route_agent_ok(agent, skills):
        print("  PERFIL: %s" % w)
    return 0


# ------------------------------------------------------------- P7 state json
def state_write():
    lst = subprocess.run(["maestri", "list"], capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=60).stdout
    agents, notes = [], []
    in_notes = False
    for line in lst.splitlines():
        s = line.strip()
        if s.startswith("Connected notes"):
            in_notes = True
            continue
        if s.startswith("- name:"):
            m = re.match(r'- name: "(.+?)"(?:, role: "(.*?)")?(, maestro: true)?', s)
            if not m:
                continue
            if in_notes:
                notes.append({"name": m.group(1), "archived": False})
            else:
                agents.append({"name": m.group(1), "role": m.group(2) or None, "maestro": bool(m.group(3))})
        m2 = re.match(r'^\u21b3 note: "(.+?)"', s)
        if m2:
            notes.append({"name": m2.group(1), "archived": "(fich" in s})
    luna = os.path.join(os.path.dirname(STATE_DIR), "external", "luna", "STATUS.md")
    luna_state = ""
    if os.path.isfile(luna):
        with open(luna, encoding="utf-8") as f:
            luna_state = f.readline().strip()
    state = {
        "schema": "maestro-state/1",
        "authoritative": True,
        "note_human_view": "MAESTRI_STATE (renderizada a partir deste JSON; se divergirem, este JSON ganha)",
        "maestro": next((a["name"] for a in agents if a.get("maestro")), None),
        "agents": agents,
        "notes": notes,
        "ownership": load(OWNERSHIP, {"tasks": []}).get("tasks", []),
        "luna": {"status": luna_state, "task": ".maestri/external/luna/TASK.md",
                 "handoff": ".maestri/external/luna/HANDOFF.md"},
        "parked": ["Aider Worker", "Goose Worker", "Crush Reviewer"],
        "skills": {"library": SKILLS_DIR,
                   "total": len([d for d in os.listdir(SKILLS_DIR) if os.path.isdir(os.path.join(SKILLS_DIR, d))]) if os.path.isdir(SKILLS_DIR) else 0,
                   "required_capabilities": 17, "delivery": "markdown-only",
                   "agent_skill_matrix": AGENT_SKILLS, "native_loaders": NATIVE_LOADERS},
        "ledger": ".maestri/state/events.jsonl",
        "blockers": ["premium-escalation.md orfao: precisa de ligacao no canvas para arquivar"],
        "updatedAt": now(),
    }
    save(STATE_JSON, state)
    print("STATE_WRITTEN: %s (%d agents, %d notas)" % (STATE_JSON, len(agents), len(notes)))
    return 0


def state_show():
    print(json.dumps(load(STATE_JSON), ensure_ascii=False, indent=2))


# ------------------------------------------------------------- P3 health
def health():
    lst = subprocess.run(["maestri", "list"], capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=60).stdout
    head = lst.split("Connected notes")[0]
    names = re.findall(r'- name: "([^"]+)"', head)
    prev = load(HEALTH_SNAP, {})
    snap, rows = {}, []
    for n in dict.fromkeys(names):
        try:
            out = subprocess.run(["maestri", "check", n], capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=45).stdout
        except Exception as e:
            rows.append((n, "UNKNOWN_ACTIVITY", "check falhou: %s" % e))
            continue
        lines = [l for l in out.strip().splitlines() if l.strip()]
        last = lines[-1].strip() if lines else ""
        h = hashlib.sha256(out.encode("utf-8", "replace")).hexdigest()[:12]
        p = prev.get(n)
        changed = bool(p) and p.get("hash") != h
        if n in ("Goose Worker", "Aider Worker", "Crush Reviewer"):
            state = "PARKED"
        elif changed:
            state = "WORKING"
        elif p:
            state = "IDLE"
        else:
            state = "CONNECTED"
        snap[n] = {"hash": h, "last_line": last[:160], "seen_at": now(),
                   "changed_since_last": changed}
        rows.append((n, state, ("output mudou face ao ultimo snapshot" if changed else
                                ("sem mudanca desde o ultimo check" if p else "primeira observacao: CONNECTED != WORKING"))))
    save(HEALTH_SNAP, snap)
    for n, st, ev in rows:
        print("%-18s %-16s %s" % (n, st, ev))
    print("NOTA: WORKING so com evidencia de mudanca de output. Sem daemon; execucao sob demanda.")
    return 0


# ------------------------------------------------- P1/P22/P23 skills audit
OPENCODE_SKILLS = os.path.expanduser("~/.config/opencode/skills")
MANIFEST = os.path.join(STATE_DIR, "skills-manifest.json")
# agent -> skills que esse agente deve ver. Fonte unica: evita 32 descriptions por agente.
AGENT_SKILLS = {
    "Freebuff Builder": ["writing-plans", "executing-plans", "context-optimization", "context-compression",
                          "thinking-toolkit", "cybersafe-delivery", "verification-before-completion",
                          "skill-security-review"],
    "OpenCode": ["systematic-debugging", "code-review-and-quality", "code-simplification",
                 "requesting-code-review", "verification-before-completion", "source-driven-development",
                 "executing-plans", "cybersafe-ipc-contract", "cybersafe-windows-native"],
    "qoder": ["react-best-practices", "impeccable", "apple-design-principles", "cybersafe-design-system",
              "cybersafe-ptpt-ui", "test-driven-development", "systematic-debugging",
              "verification-before-completion"],
    "Kilo Builder": ["systematic-debugging", "cybersafe-windows-native", "cybersafe-ipc-contract",
                     "electron-best-practices", "secpriv", "test-driven-development", "verification-before-completion"],
    "Continue Worker": ["systematic-debugging", "test-driven-development", "executing-plans",
                        "verification-before-completion"],
    "Codex Lead": ["systematic-debugging", "doubt-driven-development", "thinking-toolkit", "secpriv",
                   "electron-best-practices", "cybersafe-ipc-contract", "verification-before-completion",
                   "code-review-and-quality"],
    "Antigravity": ["thinking-toolkit", "doubt-driven-development", "secpriv", "writing-plans",
                    "cybersafe-design-system", "verification-before-completion"],
    "Luna External": ["context-optimization", "context-compression"],
    "Shell": [],
    "kiro": ["systematic-debugging", "test-driven-development", "verification-before-completion"],
}
NATIVE_LOADERS = {"OpenCode": {"kind": "NATIVE", "path": OPENCODE_SKILLS},
                  "Codex Lead": {"kind": "PARTIAL", "path": os.path.expanduser("~/.codex/skills")},
                  "Antigravity": {"kind": "UNVERIFIED", "path": "agy suporta --disable-slash-commands (skill expansion) mas nao ha diretorio de skills"},
                  "qoder": {"kind": "MAESTRO_INJECTION", "path": "-"},
                  "Kilo Builder": {"kind": "MAESTRO_INJECTION", "path": "-"},
                  "kiro": {"kind": "MAESTRO_INJECTION", "path": "-"},
                  "Continue Worker": {"kind": "MAESTRO_INJECTION", "path": "-"}}


def sha(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()


def skills_audit(write=True):
    """Spec Agent Skills + drift de mirrors + manifesto com checksums."""
    entries, bad = [], []
    for d in sorted(os.listdir(SKILLS_DIR)):
        p = os.path.join(SKILLS_DIR, d)
        sk = os.path.join(p, "SKILL.md")
        if not os.path.isdir(p):
            continue
        if not os.path.isfile(sk):
            bad.append((d, "SEM_SKILL_MD"))
            continue
        t = open(sk, encoding="utf-8", errors="replace").read()
        fm = re.match(r"^---\n(.*?)\n---\n", t, re.S)
        name = desc = ""
        if fm:
            m = re.search(r"^name:\s*(.+)$", fm.group(1), re.M)
            m2 = re.search(r"^description:\s*(.+)$", fm.group(1), re.M | re.S)
            name = m.group(1).strip() if m else ""
            desc = " ".join((m2.group(1) if m2 else "").split())
        errs = []
        if not fm:
            errs.append("sem frontmatter")
        if name != d:
            errs.append("name!=dir")
        if not re.fullmatch(r"[a-z0-9]+(-[a-z0-9]+)*", name or "x"):
            errs.append("name invalido")
        if len(name) > 64:
            errs.append("name>64")
        if not desc:
            errs.append("sem description")
        mirror = None
        mp = os.path.join(OPENCODE_SKILLS, d, "SKILL.md")
        if os.path.isfile(mp):
            mirror = "IN_SYNC" if sha(mp) == sha(sk) else "STALE"
        entries.append({"name": d, "sha256": sha(sk)[:16], "lines": len(t.splitlines()),
                        "description_chars": len(desc), "spec": errs or "OK", "opencode_mirror": mirror})
        if errs:
            bad.append((d, ";".join(errs)))
    stale = [e["name"] for e in entries if e["opencode_mirror"] == "STALE"]
    man = {
        "generatedAt": now(), "canonical": SKILLS_DIR,
        "agent_skill_matrix": AGENT_SKILLS, "native_loaders": NATIVE_LOADERS,
        "external_not_routed": {
            "task-observer": "SAFE_WITH_RESTRICTIONS (2 scripts python locais, sem rede/git destrutivo) mas description broad demais: excluido do routing",
            "project-quality": "externa, sem audit trail: NAO roteada",
            "skill-observations": "logs/artefactos de observacao: NAO roteada"},
        "skills": entries, "spec_problems": bad, "stale_mirrors": stale}
    if write:
        save(MANIFEST, man)
    print("SKILLS=%d spec_problems=%d stale_mirrors=%s" % (len(entries), len(bad), stale or "none"))
    for b in bad:
        print("  PROBLEMA %s -> %s" % b)
    return 0 if not bad else 1


def agent_skills():
    for a, s in AGENT_SKILLS.items():
        print("%-18s (%2d) %s" % (a, len(s), ", ".join(s) or "(nenhuma: shell nao e LLM)"))
    missing = [(a, s) for a, sk in AGENT_SKILLS.items() for s in sk if not skill_exists(s)]
    print("skills referenciadas e inexistentes: %s" % (missing or "nenhuma"))


def route_agent_ok(agent, skills):
    allowed = AGENT_SKILLS.get(agent)
    if allowed is None:
        return ["agente desconhecido no perfil"]
    return ["skill fora do perfil de %s: %s" % (agent, s) for s in skills if s not in allowed]


# --------------------------------------------------------------- P11 ledger
LEDGER = os.path.join(STATE_DIR, "events.jsonl")
EVIDENCE_EVENTS = ("WORK_STARTED", "ACTIVITY", "VERIFICATION", "DONE", "HANDOFF", "BLOCKED", "FAILED")
PARKED_AGENTS = ("Aider Worker", "Goose Worker", "Crush Reviewer")


def event(name, task, agent, evidence=""):
    if name in EVIDENCE_EVENTS and not evidence.strip():
        print("ERROR: evento %s exige evidence (nao inferir estado)" % name)
        return 1
    os.makedirs(STATE_DIR, exist_ok=True)
    rec = {"ts": now(), "task": task, "agent": agent, "event": name, "evidence": evidence}
    with open(LEDGER, "a", encoding="utf-8", newline="\n") as f:
        f.write(json.dumps(rec, ensure_ascii=False) + "\n")
    print("EVENT: %s %s %s" % (name, task, agent))
    return 0


def ledger_tail(n=10):
    try:
        lines = open(LEDGER, encoding="utf-8").read().strip().splitlines()
    except FileNotFoundError:
        print("LEDGER vazio (ainda sem eventos)")
        return 0
    for l in lines[-n:]:
        print(l)
    return 0


if __name__ == "__main__":
    # A consola do Windows vem em cp1252 e estraga os acentos do relatorio.
    # Um gate que imprime lixo nao é legivel, logo força-se UTF-8 com fallback.
    for _stream in (sys.stdout, sys.stderr):
        try:
            _stream.reconfigure(encoding="utf-8", errors="replace")
        except (AttributeError, OSError, ValueError):
            pass
    cmd = sys.argv[1] if len(sys.argv) > 1 else ""
    if cmd == "packet-validate":
        sys.exit(packet_validate(sys.argv[2]))
    if cmd == "ownership-check":
        sys.exit(ownership_check(sys.argv[2], sys.argv[3]))
    if cmd == "ownership-claim":
        sys.exit(ownership_claim(sys.argv[2]))
    if cmd == "ownership-transfer":
        sys.exit(ownership_transfer(sys.argv[2], sys.argv[3], sys.argv[4] if len(sys.argv) > 4 else "n/a"))
    if cmd == "ownership-show":
        ownership_show()
    elif cmd == "skills-audit":
        sys.exit(skills_audit())
    elif cmd == "agent-skills":
        agent_skills()
    elif cmd == "event":
        sys.exit(event(sys.argv[2], sys.argv[3] if len(sys.argv) > 3 else "-",
                       sys.argv[4] if len(sys.argv) > 4 else "-",
                       sys.argv[5] if len(sys.argv) > 5 else ""))
    elif cmd == "ledger":
        sys.exit(ledger_tail(int(sys.argv[2]) if len(sys.argv) > 2 else 10))
    elif cmd == "routing-eval":
        sys.exit(routing_eval())
    elif cmd == "selfcheck":
        sys.exit(selfcheck())
    elif cmd == "guardrail-resolve":
        sys.exit(guardrail_resolve(" ".join(sys.argv[2:])))
    elif cmd == "git-sync":
        git_sync()
    elif cmd == "organizer-check":
        sys.exit(organizer_check())
    elif cmd == "report-status":
        sys.exit(report_status())
    elif cmd == "report-open":
        sys.exit(report_open())
    elif cmd == "session-checkpoint":
        sys.exit(session_checkpoint())
    elif cmd == "failover-show":
        for a, chain in FAILOVER.items():
            print("%-14s -> %s" % (a, ", ".join("%s (%s)" % c for c in chain)))
        print("cost classes: %s" % json.dumps(COST_CLASS, ensure_ascii=False))
    elif cmd == "route":
        sys.exit(route(sys.argv[2]))
    elif cmd == "state-write":
        sys.exit(state_write())
    elif cmd == "state-show":
        state_show()
    elif cmd == "health":
        sys.exit(health())
    else:
        print(__doc__)
        sys.exit(2)