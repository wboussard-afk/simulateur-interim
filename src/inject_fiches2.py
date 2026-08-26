# -*- coding: utf-8 -*-
"""Fusionne fiches restructurées (w9b4zgzkt) + sources/fiabilité d'origine (w1sl6egjl)
[+ fiche 3255 (wn18y52ay) si présente] et REMPLACE le bloc de données dans conventions.html."""
import json, io, sys, re, os
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')
base = r"C:\Users\NatassaMarkopoulou\AppData\Local\Temp\claude\C--Users-NatassaMarkopoulou-OneDrive---Magen-Financial-LLC-Desktop\ab66d73f-efe1-40d7-96f5-62b4be56e0df\scratchpad"
tasks = base + r"\..\tasks"

def load(task):
    out = json.load(open(tasks + "\\" + task + ".output", encoding='utf-8'))["result"]
    return json.loads(out) if isinstance(out, str) else out

orig = {f["fiche"]["idcc"]: f["fiche"] for f in load("w1sl6egjl")["fiches"]}
restr = {f["idcc"]: f for f in load("w9b4zgzkt")["fiches"]}
assert set(orig) == set(restr), (set(orig), set(restr))

KEYMAP = {"2378": [2378], "1413": [1413], "1596/1597": [1596, 1597], "1702": [1702], "3248": [3248], "7024": [7024]}
NOTE_INTERIM = {1596, 1597, 1702, 3248, 7024, 3255}

def theme_final(t_restr, t_orig):
    th = {"cle": t_restr["cle"], "titre": t_restr["titre"], "cleValeur": t_restr.get("cleValeur", ""),
          "points": t_restr.get("points", []), "dateCourte": t_restr.get("dateCourte", "")}
    if t_restr.get("detail"): th["detail"] = t_restr["detail"]
    # source + fiabilité = données d'origine vérifiées (jamais reprises de l'agent de mise en forme)
    if t_orig:
        th["source"] = t_orig.get("source", "")
        th["fiabilite"] = t_orig.get("fiabilite", "verifie")
    else:
        th["source"] = t_restr.get("source", "")
        th["fiabilite"] = t_restr.get("fiabilite", "aConfirmer")
    return th

entries = []
for idcc, keys in KEYMAP.items():
    o, r = orig[idcc], restr[idcc]
    o_by_cle = {t["cle"]: t for t in o["themes"]}
    themes = [theme_final(t, o_by_cle.get(t["cle"])) for t in r["themes"]]
    manquants = [c for c in o_by_cle if c not in {t["cle"] for t in themes}]
    assert not manquants, (idcc, "thèmes perdus:", manquants)
    fiche = {"dateDerniereActu": o.get("dateDerniereActu", ""), "themes": themes}
    if any(k in NOTE_INTERIM for k in keys): fiche["noteInterim"] = True
    entries.append({"keys": keys, "fiche": fiche})

# fiche 3255 (workflow dédié) si déjà arrivée
titre3255 = None
try:
    d = load("wn18y52ay")
except Exception:
    d = None
if d and d.get("fiche3255"):
    f3 = d["fiche3255"]
    titre3255 = f3.get("titre", "")
    themes = [theme_final(t, None) for t in f3["themes"]]
    entries.append({"keys": [3255], "fiche": {"dateDerniereActu": f3.get("dateDerniereActu", ""),
                                              "themes": themes, "noteInterim": True}})
    print("3255 intégrée:", titre3255, "-", len(themes), "thèmes")
else:
    print("3255 pas encore disponible — fusion des 6 fiches seulement")

# flotte catalogue (workflow wu4x1jrpx) : 17 fiches structurées supplémentaires
try:
    fleet = load("ww02rlgsr")
except Exception:
    fleet = None
if fleet:
    deja = {k for e in entries for k in e["keys"]}
    n_ajout = 0
    for ff in fleet.get("fiches", []):
        if not (ff and ff.get("themes")): continue
        k = int(ff["idcc"])
        if k in deja: continue
        entries.append({"keys": [k], "fiche": {"dateDerniereActu": ff.get("dateDerniereActu", ""),
                                               "themes": [theme_final(t, None) for t in ff["themes"]],
                                               "noteInterim": True}})
        n_ajout += 1
    print("flotte catalogue:", n_ajout, "fiches ajoutées")
else:
    print("flotte catalogue pas encore disponible")

# table ancien IDCC → nouveau (workflow waqakcrog) + fiche supplémentaire éventuelle
remap = {}
try:
    w = load("w52nqs8d9")
except Exception:
    w = None
if w:
    for r in (w.get("table") or {}).get("remplacements", []):
        anc, nouv = str(r["ancien"]).strip(), str(r["nouveau"]).strip()
        if anc.isdigit() and nouv.isdigit() and anc != nouv:
            remap[int(anc)] = {"nouveau": nouv, "libelle": r.get("libelle", ""), "date": r.get("date", "")}
    ff = w.get("ficheFinale")
    if ff and ff.get("themes"):
        entries.append({"keys": [int(ff["idcc"])], "fiche": {
            "dateDerniereActu": ff.get("dateDerniereActu", ""),
            "themes": [theme_final(t, None) for t in ff["themes"]], "noteInterim": True}})
        print("fiche supplémentaire intégrée:", ff["idcc"], "-", ff.get("titre", ""))
    # cohérence : un « nouveau » ne doit pas être lui-même remplacé (pas de cycle)
    for anc, r in list(remap.items()):
        if int(r["nouveau"]) in remap:
            print("⚠ chaîne détectée:", anc, "→", r["nouveau"], "→", remap[int(r["nouveau"])]["nouveau"])
    print("remplacements:", len(remap))
else:
    print("table de remplacements pas encore disponible")

# fiches constituées en boucle principale (crash-résilient : fiches_mainloop.json) + remplacements
try:
    ml = json.load(open(base + r"\fiches_mainloop.json", encoding='utf-8'))
except Exception:
    ml = None
if ml:
    deja = {k for e in entries for k in e["keys"]}
    n_ml = 0
    for ff in ml.get("fiches", []):
        k = int(ff["idcc"])
        if k in deja: continue
        entries.append({"keys": [k], "fiche": {"dateDerniereActu": ff.get("dateDerniereActu", ""),
                                               "themes": [theme_final(t, None) for t in ff["themes"]],
                                               "noteInterim": True}})
        n_ml += 1
    for r in ml.get("remplacements", []):
        anc = str(r["ancien"]).strip()
        if anc.isdigit() and int(anc) not in remap:
            remap[int(anc)] = {"nouveau": str(r["nouveau"]), "libelle": r.get("libelle", ""), "date": r.get("date", "")}
    print("mainloop:", n_ml, "fiches,", len(ml.get("remplacements", [])), "remplacements")

payload = json.dumps(entries, ensure_ascii=False, separators=(",", ":")).replace("</", "<\\/")
payload_remap = json.dumps(remap, ensure_ascii=False, separators=(",", ":")).replace("</", "<\\/")
block = (
    "/* ----- Données des fiches (constituées le 26/08/2026, contre-vérifiées sur sources officielles ;\n"
    " *       regénérées par la veille quand un texte change — ne pas éditer à la main) ----- */\n"
    "(function () {\n"
    "  const D = " + payload + ";\n"
    "  for (const e of D) for (const k of e.keys) FICHES_CONV[k] = e.fiche;\n"
    "  Object.assign(IDCC_REMPLACES, " + payload_remap + ");\n"
    "})();\n"
)

html = open(base + r"\app\conventions.html", encoding='utf-8').read()
pat = re.compile(r"/\* ----- Données des fiches.*?\}\)\(\);\n", re.S)
assert len(pat.findall(html)) == 1, "bloc de données introuvable ou multiple"
html = pat.sub(lambda m: block, html)
open(base + r"\app\conventions.html", "w", encoding='utf-8').write(html)
print("bloc remplacé:", len(payload), "octets,", sum(len(e["keys"]) for e in entries), "clés IDCC")
