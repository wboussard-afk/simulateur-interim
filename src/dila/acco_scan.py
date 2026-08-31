# -*- coding: utf-8 -*-
"""Balayage des increments ACCO (accords d'entreprise, open data DILA) pour les SIREN suivis.

Le dump global ACCO (45 Go) n'est JAMAIS telecharge : on balaye les increments
hebdomadaires (50 Mo - 1,6 Go), on garde les seuls fichiers citant un SIREN suivi,
puis on SUPPRIME l'archive (stockage transitoire).

Usage :
  python acco_scan.py           # traite les increments pas encore vus
  python acco_scan.py --tout    # rattrapage : TOUS les increments du depot (backfill initial)
  python acco_scan.py --list    # apercu de ce qui serait traite

Correspondances : les archives couvrent juillet 2025 -> aujourd'hui ; les depots
anterieurs a juillet 2025 ne sont que dans le global (non couvert — limite connue).
Resultats : ab2pro-data/dila/acco/matches/  +  journal etat_scan.json
"""
import json, os, re, sys, tarfile, urllib.request

BASE_URL = "https://echanges.dila.gouv.fr/OPENDATA/ACCO/"
RACINE = os.path.join(os.path.expanduser("~"), "ab2pro-data", "dila", "acco")
DIR_MATCH = os.path.join(RACINE, "matches")
ETAT = os.path.join(RACINE, "etat_scan.json")
UA = {"User-Agent": "Mozilla/5.0 (veille accords AB2Pro; contact wboussard@gmail.com)"}

# SIREN suivis (groupe AB2Pro / PALMA) — synchroniser avec la routine veille-conventions-accords
SIRENS = [b"993241462", b"993289347", b"993869379"]


def lister_depot():
    req = urllib.request.Request(BASE_URL, headers=UA)
    html = urllib.request.urlopen(req, timeout=60).read().decode("utf-8", "replace")
    return sorted(set(re.findall(r'ACCO_[\d-]+\.tar\.gz', html)))


def scanner_archive(nom):
    """Telecharge l'increment en local, balaye chaque membre, garde les matches, supprime l'archive."""
    url = BASE_URL + nom
    tmp = os.path.join(RACINE, nom + ".part")
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=3600) as r, open(tmp, "wb") as f:
        while True:
            bloc = r.read(1 << 22)
            if not bloc:
                break
            f.write(bloc)
    taille = os.path.getsize(tmp)
    matches = []
    with tarfile.open(tmp, "r:gz") as t:
        for m in t:
            if not m.isfile():
                continue
            data = t.extractfile(m).read()
            if any(s in data for s in SIRENS):
                dest = os.path.join(DIR_MATCH, nom.replace(".tar.gz", ""), os.path.basename(m.name))
                os.makedirs(os.path.dirname(dest), exist_ok=True)
                with open(dest, "wb") as f:
                    f.write(data)
                matches.append(m.name)
    os.remove(tmp)
    return taille, matches


def main():
    apercu = "--list" in sys.argv
    tout = "--tout" in sys.argv
    os.makedirs(DIR_MATCH, exist_ok=True)
    etat = {"archives": {}}
    if os.path.exists(ETAT):
        etat = json.load(open(ETAT, encoding="utf-8"))

    depot = lister_depot()
    a_faire = [n for n in depot if n not in etat["archives"]] if tout else \
              [n for n in depot if n not in etat["archives"]][-4:]  # sans --tout : les ~4 dernieres semaines
    print(f"depot : {len(depot)} increments ; a traiter : {len(a_faire)} (SIREN suivis : "
          + ", ".join(s.decode() for s in SIRENS) + ")")
    if apercu:
        for n in a_faire:
            print("  -", n)
        return

    total_matches = 0
    for k, nom in enumerate(a_faire, 1):
        try:
            taille, matches = scanner_archive(nom)
        except Exception as e:
            print(f"  ! {nom} : {e} — a reprendre au prochain passage", file=sys.stderr)
            continue
        etat["archives"][nom] = {"taille": taille, "matches": len(matches)}
        total_matches += len(matches)
        print(f"  [{k}/{len(a_faire)}] {nom} ({taille/1e6:.0f} Mo) -> {len(matches)} match(es)")
        for mn in matches:
            print("      *", mn)
        json.dump(etat, open(ETAT, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    print(f"TERMINE : {len(a_faire)} archives balayees, {total_matches} document(s) retenu(s) dans {DIR_MATCH}")


if __name__ == "__main__":
    main()
