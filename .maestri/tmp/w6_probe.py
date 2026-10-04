import json, io, os, collections

base = os.path.expanduser(r"~\.cybersafe-service")
rows = []
with io.open(os.path.join(base, "history.jsonl"), encoding="utf-8", errors="replace") as f:
    for i, l in enumerate(f):
        l = l.strip()
        if not l:
            continue
        try:
            r = json.loads(l)
            r["__line"] = i + 1
            rows.append(r)
        except Exception:
            pass

by_line = {r["__line"]: r for r in rows}
for n in (91, 92, 26, 15, 1):
    r = by_line[n]
    t = r["threat"]
    print("L%d  %s" % (n, r.get("timestamp")))
    print("   filePath =", t.get("filePath"))
    print("   rules    =", t.get("rulesTriggered"))
    print()

FIX = {"knownbad.txt", "yara-probe.txt", "cybersafe-e2e-canary.txt"}
other = [r for r in rows if os.path.basename(r["threat"].get("filePath") or "") not in FIX]

roots = collections.Counter()
SEP = chr(92)
for r in other:
    p = (r["threat"].get("filePath") or "").replace("/", SEP)
    parts = p.split(SEP)
    roots[SEP.join(parts[:5]) if len(parts) > 4 else p] += 1

print("=== raizes (nao-fixture) ===")
for k, v in roots.most_common(12):
    print("  %-4d %s" % (v, k[:95]))
