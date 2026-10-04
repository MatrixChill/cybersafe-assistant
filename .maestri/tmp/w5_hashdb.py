import json, io, hashlib, os

BASE = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
BASE = r"C:\Users\caioc\Desktop\Caio\garoto de programa\cybersafe-assistant"


def sha(p):
    return hashlib.sha256(io.open(p, "rb").read()).hexdigest()


def records(p):
    d = json.load(io.open(p, encoding="utf-8-sig"))
    if isinstance(d, list):
        return d
    for k in ("signatures", "entries", "hashes"):
        if isinstance(d.get(k), list):
            return d[k]
    return []


PATHS = [
    ("repo-canonic", os.path.join(BASE, "definitions/hashes/default.json")),
    ("service-packaged", os.path.join(BASE, "packages/service/definitions/hashes/default.json")),
    ("core-packaged", os.path.join(BASE, "packages/core/definitions/hashes/default.json")),
    ("runtime", os.path.expanduser(r"~\.cybersafe-service\definitions\hashes\default.json")),
]

for label, p in PATHS:
    try:
        recs = records(p)
        raw = io.open(p, "rb").read()
    except Exception as e:
        print("%-18s ERRO %s" % (label, e))
        continue
    print("== %-18s sha=%s bytes=%d count=%d" % (label, sha(p)[:16], len(raw), len(recs)))
    for r in recs:
        h = r.get("hash") or r.get("sha256") or "?"
        fam = r.get("family") or r.get("malwareName") or r.get("name") or "?"
        print("     %-22s family=%-16s source=%s" % (h[:22], str(fam)[:16], r.get("source")))
    has71 = any((r.get("hash") or r.get("sha256") or "").startswith("71b6") for r in recs)
    print("     TRICKBOT_71B6_PRESENT = %s" % ("SIM" if has71 else "NAO"))
    print()
