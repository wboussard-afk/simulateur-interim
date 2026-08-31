# -*- coding: utf-8 -*-
"""Detection hebdomadaire des nouveautes conventionnelles pour les IDCC suivis,
par DIFF des conteneurs KALI sur les increments DILA (donnee authentique).

Principe : tout nouveau texte attache a une convention re-emet le XML de son conteneur
(sa table des matieres change) ; toute extension/abrogation re-emet le XML version du texte.
On balaye donc les increments non encore traites :
  - conteneur suivi re-emis  -> diff des LIEN_TXT vs l'etat -> NOUVEAUX textes ;
  - version d'un texte deja connu re-emise -> changement d'etat/extension a signaler.

Usage :
  python kali_veille.py --etat <chemin etat.json> --idcc 2378,1413,1596,1597,1702,3248,7024,3255,7028,...
  (premier passage : seede l'etat sans rien signaler ; passages suivants : rapport des nouveautes)

Prerequis : kali_sync.py execute juste avant (increments a jour) puis kali_query.py index
(index + conteneurs.json a jour). Sortie : rapport texte sur stdout, vide si RAS.
"""
import gzip, json, os, re, sys, tarfile
import xml.etree.ElementTree as ET

RACINE = os.path.join(os.path.expanduser("~"), "ab2pro-data", "dila", "kali")
DIR_INCR = os.path.join(RACINE, "increments")
ID_RE = re.compile(r'(KALI(?:CONT|TEXT|ARTI)\d{12})\.xml$')

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from kali_query import extraire, charger_index, _txt  # noqa: E402


def liens_du_conteneur(xml):
    r = ET.fromstring(xml)
    liens = {}
    for lien in r.iter("LIEN_TXT"):
        idt = lien.get("idtxt") or ""
        if idt.startswith("KALITEXT"):
            liens[idt] = lien.get("titretxt") or ""
    return liens


def meta_texte(idt, idx):
    try:
        r = ET.fromstring(extraire(idt, idx))
        return {"date": _txt(r, ".//DATE_TEXTE", "?"), "etat": _txt(r, ".//ETAT", "?"),
                "extension": _txt(r, ".//LIBELLE_EXTENSION"),
                "titre": _txt(r, ".//TITREFULL") or _txt(r, ".//TITRE"),
                "publi": _txt(r, ".//ORIGINE_PUBLI"), "nor": _txt(r, ".//NOR")}
    except Exception as e:
        return {"date": "?", "etat": f"(illisible : {e})", "extension": "", "titre": "", "publi": "", "nor": ""}


def main():
    args = dict(zip(sys.argv[1::2], sys.argv[2::2]))
    chemin_etat = args.get("--etat")
    idccs = [x.strip() for x in args.get("--idcc", "").split(",") if x.strip()]
    if not chemin_etat or not idccs:
        print(__doc__)
        sys.exit(2)

    conts_map = json.load(open(os.path.join(RACINE, "conteneurs.json"), encoding="utf-8"))
    suivis = {}  # KALICONT -> idcc
    for k, v in conts_map.items():
        if v.get("idcc") in idccs:
            suivis[k] = v["idcc"]
    # conteneurs explicites (conventions sans balise NUM, ex. 1413 = accord national permanents ETT)
    for paire in (args.get("--extra", "") or "").split(","):
        if ":" in paire:
            cid, idcc = paire.split(":", 1)
            suivis[cid.strip()] = idcc.strip()
    absents = [i for i in idccs if i not in set(suivis.values())]

    etat = {"increments_traites": [], "conteneurs": {}}
    if os.path.exists(chemin_etat):
        etat = json.load(open(chemin_etat, encoding="utf-8"))
    premier = not etat["conteneurs"]
    idx = charger_index()

    rapport = []
    if absents:
        rapport.append(f"! IDCC sans conteneur KALI dans la carte : {', '.join(absents)} — verifier (fusion ? code errone ?)")

    if premier:
        for cont, idcc in sorted(suivis.items()):
            liens = liens_du_conteneur(extraire(cont, idx))
            etat["conteneurs"][cont] = {"idcc": idcc, "textes": sorted(liens)}
        etat["increments_traites"] = sorted(os.listdir(DIR_INCR))
        json.dump(etat, open(chemin_etat, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
        print(f"(premier passage : base etablie — {len(suivis)} conteneurs, aucun signalement)")
        for ligne in rapport:   # les avertissements (IDCC sans conteneur...) s'affichent aussi au seed
            print(" -", ligne)
        return

    nouveaux_incr = [n for n in sorted(os.listdir(DIR_INCR))
                     if n.endswith(".tar.gz") and n not in set(etat["increments_traites"])]
    touches_cont, touches_txt = set(), set()
    connus = {t for c in etat["conteneurs"].values() for t in c["textes"]}
    for n in nouveaux_incr:
        try:
            with tarfile.open(os.path.join(DIR_INCR, n), "r:gz") as t:
                for m in t.getnames():
                    mm = ID_RE.search(m)
                    if not mm:
                        continue
                    ident = mm.group(1)
                    if ident in suivis and ident.startswith("KALICONT"):
                        touches_cont.add(ident)
                    elif ident in connus and "/struct/" not in m:
                        touches_txt.add(ident)
        except Exception as e:
            rapport.append(f"! increment illisible {n} : {e}")

    for cont in sorted(touches_cont):
        idcc = suivis[cont]
        avant = set(etat["conteneurs"].get(cont, {}).get("textes", []))
        liens = liens_du_conteneur(extraire(cont, idx))
        for idt in sorted(set(liens) - avant):
            m = meta_texte(idt, idx)
            rapport.append(f"NOUVEAU TEXTE — IDCC {idcc} : {m['titre'] or liens[idt]} "
                           f"({m['date']}, etat {m['etat']}"
                           + (f", {m['extension']}" if m['extension'] else "")
                           + (f", {m['publi']}" if m['publi'] else "") + f") [{idt}]")
        etat["conteneurs"][cont] = {"idcc": idcc, "textes": sorted(liens)}

    for idt in sorted(touches_txt):
        m = meta_texte(idt, idx)
        rapport.append(f"TEXTE MODIFIE (etat/extension) : {m['titre']} — etat {m['etat']}"
                       + (f", {m['extension']}" if m['extension'] else "") + f" [{idt}]")

    etat["increments_traites"] = sorted(set(etat["increments_traites"]) | set(nouveaux_incr))
    json.dump(etat, open(chemin_etat, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    if rapport:
        print(f"{len(rapport)} signalement(s) sur {len(nouveaux_incr)} increment(s) :")
        for ligne in rapport:
            print(" -", ligne)
    else:
        print(f"RAS ({len(nouveaux_incr)} increment(s) balayes, {len(suivis)} conteneurs suivis)")


if __name__ == "__main__":
    main()
