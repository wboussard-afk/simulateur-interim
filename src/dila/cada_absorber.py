# -*- coding: utf-8 -*-
"""Routine quotidienne « cada-absorber » — absorbe les réponses des mairies (registres des
meublés de tourisme, obtenus via demandes CADA) dans la base du portail AB Service.

Circuit : la mairie répond à info+u<id>@abservice-logement.com -> worker mail-fanout ->
table D1 `cada_reponses` (statut a_traiter, pièces jointes en base64).

Usage (exécuté par la tâche planifiée, Claude fait l'extraction intelligente entre les 2 étapes) :
  python cada_absorber.py pull                 # récupère les réponses a_traiter -> ~/ab2pro-data/cada/<id>/ + manifest
  python cada_absorber.py integrer <id> <lignes.json> [notes]
        # lignes.json : [{"c":commune,"d":dep,"a":adresse,"cap":"4","p":"juin-sept","cl":"3 étoiles"}]
        # -> fusionne dans src/auth/assets/app/data/meubles-mairies.json (dédoublonnage adresse+commune),
        #    wrangler deploy (données seules, JAMAIS commitées), statut traitee en D1
  python cada_absorber.py ignorer <id> [notes] # réponse hors sujet -> statut ignoree
"""
import base64, io, json, os, subprocess, sys, datetime, re

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
HOME = os.path.expanduser("~")
REPO = os.path.join(HOME, "ab2pro-repo")
AUTH = os.path.join(REPO, "src", "auth")
BASE = os.path.join(AUTH, "assets", "app", "data", "meubles-mairies.json")
TRAVAIL = os.path.join(HOME, "ab2pro-data", "cada")
WRANGLER = os.path.join(os.environ.get("APPDATA", ""), "npm", "wrangler.cmd")


def d1(sql, json_out=True):
    cmd = [WRANGLER, "d1", "execute", "ab2pro-auth", "--remote", "--command", sql, "-y"] + (["--json"] if json_out else [])
    r = subprocess.run(cmd, cwd=AUTH, capture_output=True, text=True, encoding="utf-8", errors="replace")
    if r.returncode != 0:
        raise SystemExit("wrangler d1 KO : " + (r.stderr or r.stdout)[-800:])
    if not json_out:
        return None
    txt = r.stdout[r.stdout.index("["):]
    return json.loads(txt)[0]["results"]


def sq(s):  # échappement SQL minimal (les chaînes viennent de nous ou d'ids)
    return str(s).replace("'", "''")


def pull():
    os.makedirs(TRAVAIL, exist_ok=True)
    lignes = d1("SELECT id, recu_le, user_id, de, sujet, texte, pieces FROM cada_reponses WHERE statut='a_traiter' ORDER BY id")
    if not lignes:
        print("AUCUNE réponse de mairie à traiter.")
        return
    for l in lignes:
        dossier = os.path.join(TRAVAIL, str(l["id"]))
        os.makedirs(dossier, exist_ok=True)
        pieces = json.loads(l.get("pieces") or "[]")
        noms = []
        for k, p in enumerate(pieces):
            nom = re.sub(r"[^\w.\-]+", "_", p.get("nom") or f"piece{k}")[:80]
            chemin = os.path.join(dossier, f"{k:02d}_{nom}")
            if p.get("b64"):
                open(chemin, "wb").write(base64.b64decode(p["b64"]))
                noms.append(chemin)
            else:
                noms.append(chemin + " (TROP VOLUMINEUSE > 700 Ko : récupérer sur la boîte admin)")
        open(os.path.join(dossier, "message.txt"), "w", encoding="utf-8").write(
            f"De : {l['de']}\nReçu le : {l['recu_le']}\nSujet : {l['sujet']}\nDemandeur (user_id) : {l['user_id']}\n\n{l['texte']}")
        print(f"=== RÉPONSE #{l['id']} — de {l['de']} — reçue {l['recu_le']} — sujet : {l['sujet']}")
        print("    texte : " + os.path.join(dossier, "message.txt"))
        for n in noms:
            print(f"    pièce : {n}")
    print(f"\n{len(lignes)} réponse(s) à traiter. Pour chacune : lire le texte et les pièces, extraire les meublés "
          f"(commune, département, adresse, capacité, périodes, classement) puis :\n"
          f"  python cada_absorber.py integrer <id> <lignes.json>   ou   python cada_absorber.py ignorer <id> \"raison\"")


def charger_base():
    try:
        return json.load(open(BASE, encoding="utf-8"))
    except Exception:
        return {"maj": None, "n": 0, "m": []}


def deployer():
    r = subprocess.run([WRANGLER, "deploy"], cwd=AUTH, capture_output=True, text=True, encoding="utf-8", errors="replace")
    ok = r.returncode == 0
    print("wrangler deploy :", "OK" if ok else "KO " + (r.stderr or r.stdout)[-500:])
    return ok


def integrer(rid, fichier, notes=""):
    lignes = json.load(open(fichier, encoding="utf-8"))
    base = charger_base()
    cle = lambda x: (norm(x.get("c")), norm(x.get("a")))
    existants = {cle(x) for x in base["m"]}
    ajout = 0
    src = "mairie #" + str(rid) + " · " + datetime.date.today().strftime("%d/%m/%Y")
    for x in lignes:
        if not x.get("c") or not x.get("a"):
            continue
        if cle(x) in existants:
            continue
        base["m"].append({"c": x["c"], "d": x.get("d", ""), "a": x["a"], "cap": str(x.get("cap", "")),
                          "p": x.get("p", ""), "cl": x.get("cl", ""), "src": src})
        existants.add(cle(x)); ajout += 1
    base["n"] = len(base["m"]); base["maj"] = datetime.date.today().strftime("%d/%m/%Y")
    json.dump(base, open(BASE, "w", encoding="utf-8"), ensure_ascii=False, separators=(",", ":"))
    print(f"{ajout} meublé(s) ajouté(s) (doublons ignorés) — base : {base['n']}")
    if deployer():
        d1(f"UPDATE cada_reponses SET statut='traitee', traite_le=datetime('now'), notes='{sq(notes or (str(ajout) + ' meublés'))}' WHERE id={int(rid)}", json_out=False)
        print(f"réponse #{rid} marquée traitée")


def ignorer(rid, notes=""):
    d1(f"UPDATE cada_reponses SET statut='ignoree', traite_le=datetime('now'), notes='{sq(notes)}' WHERE id={int(rid)}", json_out=False)
    print(f"réponse #{rid} ignorée")


def norm(s):
    import unicodedata
    s = unicodedata.normalize("NFD", str(s or "")).encode("ascii", "ignore").decode().lower()
    return re.sub(r"[^a-z0-9]+", "", s)


if __name__ == "__main__":
    a = sys.argv[1:]
    if not a or a[0] == "pull":
        pull()
    elif a[0] == "integrer" and len(a) >= 3:
        integrer(a[1], a[2], a[3] if len(a) > 3 else "")
    elif a[0] == "ignorer" and len(a) >= 2:
        ignorer(a[1], a[2] if len(a) > 2 else "")
    else:
        print(__doc__)
