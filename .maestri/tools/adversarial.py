#!/usr/bin/env python3
"""Testes adversariais do maestro.py. Nao toca em produto; usa /tmp."""
import json, os, subprocess, sys, tempfile, shutil
HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import maestro as M

TMP = tempfile.mkdtemp(prefix="maestro-adv-")
FAILS = []

def case(name, got, want):
    ok = got == want
    print(("PASS  " if ok else "FAIL  ") + name + ("  got=%r want=%r" % (got, want) if not ok else ""))
    if not ok:
        FAILS.append(name)

def write(d):
    p = os.path.join(TMP, "p.json"); json.dump(d, open(p, "w", encoding="utf-8")); return p

base = {"TASK": "t", "WRITER": "OpenCode", "SCOPE": "nenhum", "REVIEWER": "qoder",
        "REQUIRED_SKILLS": ["systematic-debugging", "verification-before-completion"],
        "SKILLS_DELIVERY": "MAESTRO_INJECTION",
        "INJECTED_SECTIONS": {"systematic-debugging": "a", "verification-before-completion": "b"},
        "SKILLS_LOADED": "YES", "START_ALLOWED": "YES", "ACCEPTANCE": "a", "TESTS": "t",
        "VERIFICATION_EVIDENCE": "evidencia", "DONE_ALLOWED": "YES", "CREATED_AT": "2026-10-01T20:00:00Z"}

def q(**kw):
    d = dict(base); d.update(kw); return write(d)

# 1 skill inexistente
case("1 skill inexistente rejeitada", M.packet_validate(q(REQUIRED_SKILLS=["systematic-debugging", "skill-fantasma"])), 1)
# 2 mais de 4 skills
case("2 >4 skills rejeitado", M.packet_validate(q(REQUIRED_SKILLS=["systematic-debugging","thinking-toolkit","secpriv","react-best-practices","impeccable"])), 1)
# 3 START_ALLOWED=YES sem skills carregadas
case("3 START sem SKILLS_LOADED", M.packet_validate(q(SKILLS_LOADED="NO")), 1)
# 4 DONE sem evidencia
case("4 DONE sem VERIFICATION_EVIDENCE", M.packet_validate(q(VERIFICATION_EVIDENCE="", DONE_ALLOWED="YES")), 1)
# 7 reviewer == writer -> aviso (nao erro): writerequals reviewer com WARN => rc 0
case("7 reviewer==writer => aviso, nao erro", M.packet_validate(q(REVIEWER="OpenCode")), 0)
# 8 writer PARKED
case("8 writer PARKED rejeitado", M.packet_validate(q(WRITER="Goose Worker")), 1)
# 9 Luna sem candidate explicito em long_context
d = dict(base); d["TYPE"] = "long_context"; d["WRITER"] = "Luna External"
case("9 long_context sem LUNA_CANDIDATE", M.packet_validate(write(d)), 1)
# 10 timestamp invalido
case("10 CREATED_AT invalido", M.packet_validate(q(CREATED_AT="ontem")), 1)

# 5/6 ownership overlap (path-aware)
own = os.path.join(TMP, "own.json"); M.OWNERSHIP = own
M.save(own, {"tasks": [{"task": "T1", "scope": "packages/app", "writer": "qoder", "status": "CLAIMED"}]})
case("6a packages/app vs packages/app/src", M.scopes_overlap("packages/app", "packages/app/src"), True)
case("6b packages/app vs packages/api", M.scopes_overlap("packages/app", "packages/api"), False)
case("6c normalizacao case/slashes", M.scopes_overlap("Packages/App/", "packages"+chr(92)+"app"+chr(92)+"src"), True)
case("5 writer diferente em scope sobreposto", M.ownership_check("packages/app/src/pages", "OpenCode"), 1)
case("5b mesmo writer sem conflito", M.ownership_check("packages/app/src", "qoder"), 0)

# 11 event sem evidence
led = os.path.join(TMP, "e.jsonl"); M.LEDGER = led
case("11 WORK_STARTED sem evidence", M.event("WORK_STARTED", "t", "OpenCode", ""), 1)
case("11b PACKET_SENT sem evidence ok", M.event("PACKET_SENT", "t", "Freebuff Builder", ""), 0)
# 12 ledger append-only / leitura
before = open(led, encoding="utf-8").read().count("\n")
M.event("ACTIVITY", "t", "OpenCode", "saida mudou")
after = open(led, encoding="utf-8").read().count("\n")
case("12 ledger append-only", after > before, True)

# 13 state durability: escrita atomica produz JSON valido e nao deixa .tmp
st = os.path.join(TMP, "state.json"); M.save(st, {"a": 1})
case("13 state valido apos save", json.load(open(st, encoding="utf-8"))["a"], 1)
case("13b sem ficheiro .tmp orfao", os.path.exists(st + ".tmp"), False)


# 14 git sync: machine de estados
for args, want in ((("main","origin/main",0,0,0),"CLEAN_SYNCED"),
                   (("main","origin/main",3,0,0),"CLEAN_AHEAD"),
                   (("main","origin/main",0,0,5),"DIRTY_LOCAL"),
                   (("main","origin/main",2,1,0),"DIVERGED"),
                   (("main","",0,0,0),"NO_UPSTREAM"),
                   (("","",0,0,0),"REMOTE_UNAVAILABLE")):
    case("14 sync %s" % (want,), M.classify_sync(*args), want)
# 15 commit plan: nunca mistura infra/produto/docs/scratch
plan = M.commit_plan([".maestri/tools/x.py","packages/app/src/a.tsx","docs/x.md","tmp.log"])
groups = [l.split(":")[0].strip() for l in plan]
case("15 commit plan 4 grupos separados", sorted(groups), sorted(["maestri-infra","docs","product","scratch-temp"]))
# 16 secretos e artefactos detectados
case("16 .env detectado", bool(M.SECRET_PAT.search("packages/api/.env")), True)
case("16b key detectado", bool(M.SECRET_PAT.search("certs/server.pem")), True)
case("16c dist detectado", bool(M.BUILD_PAT.search("packages/app/dist/index.js")), True)
case("16d source normal nao marcado", bool(M.SECRET_PAT.search("packages/app/src/App.tsx")), False)

shutil.rmtree(TMP, ignore_errors=True)
print("\nRESULT: %s (%d falhas)" % ("OK" if not FAILS else "FALHAS: %s" % FAILS, len(FAILS)))
sys.exit(1 if FAILS else 0)
