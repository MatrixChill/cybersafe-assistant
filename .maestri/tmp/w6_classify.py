import json, io, os, collections, re

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

SEP = chr(92)
FIX = {"knownbad.txt", "yara-probe.txt", "cybersafe-e2e-canary.txt"}
# tmpdir de teste criado na RAIZ do perfil (nao em AppData\Local\Temp)
LEAK = re.compile(r"^[A-Za-z]:\\Users\\[^\\]+\\cybersafe-[A-Za-z0-9-]+-[A-Za-z0-9]{6}\\")
TEMP = re.compile(r"^[A-Za-z]:\\Users\\[^\\]+\\AppData\\Local\\Temp\\")
REPO = "garoto de programa"

buckets = collections.Counter()
detail = collections.defaultdict(list)

for r in rows:
    p = (r["threat"].get("filePath") or "")
    bn = os.path.basename(p)
    if bn in FIX:
        k = "A_CERTAIN_FIXTURE_NAME"
    elif LEAK.match(p):
        k = "B_CERTAIN_TEST_TMPDIR_IN_PROFILE_ROOT"
    elif TEMP.match(p):
        k = "C_TMP_SCAN_AMBIGUOUS"
    elif REPO in p:
        k = "D_OWN_REPO_SOURCE"
    elif p.lower().endswith(".whl"):
        k = "E_USER_REAL_DATA"
    else:
        k = "F_OTHER"
    buckets[k] += 1
    detail[k].append(r)

print("TOTAL =", len(rows))
for k in sorted(buckets):
    print("  %-38s %d" % (k, buckets[k]))
print()

for k in ("B_CERTAIN_TEST_TMPDIR_IN_PROFILE_ROOT", "D_OWN_REPO_SOURCE", "F_OTHER"):
    print("=== %s (%d) ===" % (k, buckets[k]))
    for r in detail[k][:14]:
        t = r["threat"]
        print("  L%-4d %s %s" % (r["__line"], (r.get("timestamp") or "")[:19], (t.get("filePath") or "")[:100]))
    if buckets[k] > 14:
        print("  ... +%d" % (buckets[k] - 14))
    print()

print("=== C_TMP_SCAN_AMBIGUOUS: bases distintas ===")
for k, v in collections.Counter(
    os.path.basename(r["threat"].get("filePath") or "") for r in detail["C_TMP_SCAN_AMBIGUOUS"]
).most_common(20):
    print("  %-46s %d" % (k[:46], v))
print()

print("=== B: directórios de teste vazados (prefixo) ===")
dirs = collections.Counter()
for r in detail["B_CERTAIN_TEST_TMPDIR_IN_PROFILE_ROOT"]:
    p = r["threat"]["filePath"].replace("/", SEP)
    dirs["\\".join(p.split(SEP)[:4])] += 1
for k, v in dirs.most_common(20):
    print("  %-58s %d" % (k[:58], v))
print("  DIRECTORIOS DISTINTOS =", len(dirs))
