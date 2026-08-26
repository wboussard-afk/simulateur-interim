# -*- coding: utf-8 -*-
"""Assemble the self-contained simulateur-agri.html (inline db.js + engine.js)."""
import io, sys, re, os
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')
# base = dossier du script (fonctionne dans le scratchpad comme dans src/ du dépôt GitHub)
base = os.path.dirname(os.path.abspath(__file__))
app = open(base + r"\app\app.html", encoding='utf-8').read()
db = open(base + r"\app\db.js", encoding='utf-8').read()
eng = open(base + r"\app\engine.js", encoding='utf-8').read()
geo = open(base + r"\app\geo.js", encoding='utf-8').read()
# drop the GOLDEN payloads from the shipped file (test-only data)
db_ship = re.sub(r"var GOLDEN_NEW = .*?;\n", "", db, flags=re.S)
db_ship = re.sub(r"var GOLDEN_V1 = .*?;\n", "", db_ship, flags=re.S)
db_ship = db_ship.replace("if (typeof module !== 'undefined') module.exports = { DB: DB, GOLDEN_NEW: GOLDEN_NEW, GOLDEN_V1: GOLDEN_V1 };\n", "")
out = app.replace('<script src="db.js?r1"></script>', '<script>\n' + db_ship + '</script>')
out = out.replace('<script src="engine.js?r1"></script>', '<script>\n' + eng + '</script>')
out = out.replace('<script src="geo.js?r1"></script>', '<script>\n' + geo + '</script>')
assert 'src="db.js' not in out and 'src="engine.js' not in out and 'src="geo.js' not in out
open(base + r"\app\simulateur-agri.html", 'w', encoding='utf-8').write(out)
print("simulateur-agri.html:", len(out), "bytes")

# variante artifact : contenu sans squelette doctype/html/head/body (fourni au déploiement)
art = out
art = re.sub(r'<!doctype html>\s*<html lang="fr">\s*<head>\s*', '', art)
art = art.replace('<meta charset="utf-8">\n', '').replace('<meta name="viewport" content="width=device-width, initial-scale=1">\n', '')
art = art.replace('</head>\n<body>\n', '').replace('</body>\n</html>\n', '')
open(base + r"\app\artifact.html", 'w', encoding='utf-8').write(art)
assert '<html' not in art and '</body>' not in art and '<title>' in art[:8000]
print("artifact.html:", len(art), "bytes")

# ===== Veille Paie (application conformité pour les gestionnaires de paie) =====
paie = open(base + r"\app\paie.html", encoding='utf-8').read()
outp = paie.replace('<script src="db.js?r1"></script>', '<script>\n' + db_ship + '</script>')
outp = outp.replace('<script src="engine.js?r1"></script>', '<script>\n' + eng + '</script>')
outp = outp.replace('<script src="geo.js?r1"></script>', '<script>\n' + geo + '</script>')
assert 'src="db.js' not in outp and 'src="engine.js' not in outp and 'src="geo.js' not in outp
open(base + r"\app\veille-paie.html", 'w', encoding='utf-8').write(outp)
print("veille-paie.html:", len(outp), "bytes")
artp = outp
artp = re.sub(r'<!doctype html>\s*<html lang="fr">\s*<head>\s*', '', artp)
artp = artp.replace('<meta charset="utf-8">\n', '').replace('<meta name="viewport" content="width=device-width, initial-scale=1">\n', '')
artp = artp.replace('</head>\n<body>\n', '').replace('</body>\n</html>\n', '')
open(base + r"\app\artifact-paie.html", 'w', encoding='utf-8').write(artp)
assert '<html' not in artp and '</body>' not in artp and '<title>' in artp[:8000]
print("artifact-paie.html:", len(artp), "bytes")

# ===== Portail (accès unique aux 3 apps) — geo.js seul (logo) =====
port = open(base + r"\app\portail.html", encoding='utf-8').read()
outport = port.replace('<script src="geo.js?r1"></script>', '<script>\n' + geo + '</script>')
assert 'src="geo.js' not in outport
open(base + r"\app\portail-github.html", 'w', encoding='utf-8').write(outport)
print("portail-github.html:", len(outport), "bytes")
outportb = outport.replace('href="simulateur.html"', 'href="Simulateur Intérim.html"') \
                  .replace('href="paie.html"', 'href="Veille Paie.html"') \
                  .replace('href="conventions.html"', 'href="Veille Conventions.html"')
open(base + r"\app\portail-bureau.html", 'w', encoding='utf-8').write(outportb)
print("portail-bureau.html:", len(outportb), "bytes")

# ===== Veille Conventions (IDCC & accords) — engine.js (grilles BTP) + geo.js (logo) =====
conv = open(base + r"\app\conventions.html", encoding='utf-8').read()
outc = conv.replace('<script src="engine.js?r1"></script>', '<script>\n' + eng + '</script>')
outc = outc.replace('<script src="geo.js?r1"></script>', '<script>\n' + geo + '</script>')
assert 'src="geo.js' not in outc and 'src="engine.js' not in outc
open(base + r"\app\veille-conventions.html", 'w', encoding='utf-8').write(outc)
print("veille-conventions.html:", len(outc), "bytes")
artc = outc
artc = re.sub(r'<!doctype html>\s*<html lang="fr">\s*<head>\s*', '', artc)
artc = artc.replace('<meta charset="utf-8">\n', '').replace('<meta name="viewport" content="width=device-width, initial-scale=1">\n', '')
artc = artc.replace('</head>\n<body>\n', '').replace('</body>\n</html>\n', '')
open(base + r"\app\artifact-conventions.html", 'w', encoding='utf-8').write(artc)
assert '<html' not in artc and '</body>' not in artc and '<title>' in artc[:8000]
print("artifact-conventions.html:", len(artc), "bytes")

# ===== Portail sécurisé Cloudflare : alimente auth/assets/app/ si le dossier existe =====
auth_app = os.path.join(base, "auth", "assets", "app")
if os.path.isdir(os.path.join(base, "auth")):
    os.makedirs(auth_app, exist_ok=True)
    for src_name, dst_name in [("portail-github.html", "index.html"), ("simulateur-agri.html", "simulateur.html"),
                               ("veille-paie.html", "paie.html"), ("veille-conventions.html", "conventions.html")]:
        data = open(base + r"\app" + "\\" + src_name, encoding='utf-8').read()
        open(os.path.join(auth_app, dst_name), 'w', encoding='utf-8').write(data)
    print("auth/assets/app/ alimenté (4 pages protégées)")
