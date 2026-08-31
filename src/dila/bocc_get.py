# -*- coding: utf-8 -*-
"""Recuperation d'un texte au BOCC (bulletin officiel des conventions collectives, open data DILA).

Complement de kali_query.py : quand un tableau annexe n'est pas numerise dans KALI
(cas frequent des grilles « tableau joint »), le porteur authentique est le PDF du BOCC.
Le numero de bulletin est dans le XML version du texte KALI (balise ORIGINE_PUBLI, ex. « BO n°2026-8 »).

Usage :
  python bocc_get.py 2026 8                     # liste les annonces du bulletin 2026-8 (IDCC + NOR + piece)
  python bocc_get.py 2026 8 --nor ASET2650194M  # extrait le PDF de l'annonce et imprime son texte
  python bocc_get.py 2026 8 --piece 20          # idem par numero de piece

Bulletins caches dans ab2pro-data/dila/bocc/. Annee courante : FluxAnneeCourante/ ;
annees passees : repertoire /YYYY/ du depot.
"""
import os, re, sys, tarfile, urllib.request

BASE = "https://echanges.dila.gouv.fr/OPENDATA/BOCC/"
RACINE = os.path.join(os.path.expanduser("~"), "ab2pro-data", "dila", "bocc")
UA = {"User-Agent": "Mozilla/5.0 (veille conventionnelle AB2Pro; contact wboussard@gmail.com)"}


def bulletin(annee, num):
    nom = f"CCO{annee}{int(num):04d}.complet.taz"
    dest = os.path.join(RACINE, nom)
    if not os.path.exists(dest):
        os.makedirs(RACINE, exist_ok=True)
        derniere = None
        for rep in (f"FluxAnneeCourante/", f"{annee}/"):
            url = BASE + rep + nom
            try:
                req = urllib.request.Request(url, headers=UA)
                with urllib.request.urlopen(req, timeout=300) as r, open(dest + ".part", "wb") as f:
                    f.write(r.read())
                os.replace(dest + ".part", dest)
                break
            except Exception as e:
                derniere = e
        if not os.path.exists(dest):
            raise RuntimeError(f"bulletin {annee}-{num} introuvable au depot ({derniere})")
    return dest


def annonces(chemin):
    with tarfile.open(chemin, "r:*") as t:
        xml_nom = next(n for n in t.getnames() if n.endswith(".xml"))
        xml = t.extractfile(xml_nom).read().decode("utf-8", "replace")
    out = []
    for bloc in re.split(r"<ANNONCE_REF>", xml)[1:]:
        g = lambda balise: (re.search(rf"<{balise}>([^<]*)</{balise}>", bloc) or [None, ""])[1]
        out.append({"piece": g("NOM_HTML"), "idcc": g("IDCC"), "nor": g("NOR"),
                    "nature": g("TEXTE_NATURE"), "numero": g("TEXTE_NUMERO"),
                    "date": g("TEXTE_DATE"), "titre": g("TEXTE_TITRE")})
    return out


def main():
    annee, num = sys.argv[1], sys.argv[2]
    nor = sys.argv[sys.argv.index("--nor") + 1] if "--nor" in sys.argv else None
    piece = sys.argv[sys.argv.index("--piece") + 1] if "--piece" in sys.argv else None
    chemin = bulletin(annee, num)
    liste = annonces(chemin)
    if not nor and not piece:
        for a in liste:
            print(f"{a['piece']}  IDCC {a['idcc'] or '----':>5}  {a['nor']:<14} {a['nature']} {a['numero']} du {a['date']} — {a['titre'][:80]}")
        return
    cible = None
    for a in liste:
        if (nor and a["nor"] == nor) or (piece and a["piece"].endswith(f"_{int(piece):04d}.pdf")):
            cible = a
            break
    if not cible:
        print("annonce introuvable dans ce bulletin", file=sys.stderr)
        sys.exit(1)
    with tarfile.open(chemin, "r:*") as t:
        data = t.extractfile(cible["piece"]).read()
    pdf = os.path.join(RACINE, f"{annee}-{num}_{cible['piece']}")
    open(pdf, "wb").write(data)
    import pymupdf
    doc = pymupdf.open(pdf)
    print(f"### {cible['titre']} (NOR {cible['nor']}, {len(doc)} pages, PDF : {pdf})")
    for pg in doc:
        print(f"--- page {pg.number + 1} ---")
        print(pg.get_text())


if __name__ == "__main__":
    main()
