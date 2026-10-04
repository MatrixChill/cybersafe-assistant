"""
Fingerprint read-only de %USERPROFILE%\.cybersafe-service + raiz do perfil.
Uso:  python home_fingerprint.py before|after <ficheiro.json>
NUNCA escreve em ~/.cybersafe-service — apenas le e grava o relatorio num
ficheiro dentro de .maestri/tmp/.
"""
import hashlib
import io
import json
import os
import sys

HOME = os.path.expanduser(r"~\.cybersafe-service")
PROFILE_ROOT = os.path.expanduser("~")
OUT_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)))


def fp_tree(root):
    out = {}
    if not os.path.isdir(root):
        return out
    for dirpath, dirnames, filenames in os.walk(root):
        for name in filenames:
            p = os.path.join(dirpath, name)
            try:
                st = os.stat(p)
            except OSError as e:
                out[os.path.relpath(p, root)] = ["stat-error", str(e)]
                continue
            out[os.path.relpath(p, root)] = [st.st_size, st.st_mtime_ns]
    return out


def sha(p):
    h = hashlib.sha256()
    with io.open(p, "rb") as f:
        for chunk in iter(lambda: f.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()[:16]


def main():
    mode = sys.argv[1]
    label = sys.argv[2] if len(sys.argv) > 2 else mode

    svc = fp_tree(HOME)
    # Raiz do perfil: so directórios de primeiro nível cujo nome casa o padrão
    # de tmpdir de teste (prova de vazamento para fora de .cybersafe-service).
    leaked = {}
    try:
        for name in os.listdir(PROFILE_ROOT):
            low = name.lower()
            if low.startswith("cybersafe-") and os.path.isdir(os.path.join(PROFILE_ROOT, name)):
                leaked[name] = len(os.listdir(os.path.join(PROFILE_ROOT, name)))
    except OSError:
        pass

    data = {
        "label": label,
        "home": HOME,
        "file_count": len(svc),
        "files": svc,
        "leaked_test_dirs_in_profile_root": leaked,
    }
    path = os.path.join(OUT_DIR, "fp-%s.json" % label)
    with io.open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=1, sort_keys=True)
    print("FP[%s] .cybersafe-service files=%d  leaked_test_dirs=%d  -> %s"
          % (label, len(svc), len(leaked), path))


if __name__ == "__main__":
    main()
