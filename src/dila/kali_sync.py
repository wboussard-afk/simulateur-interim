# -*- coding: utf-8 -*-
"""Synchronisation locale de la base KALI (conventions collectives) depuis l'open data DILA.

Source authentique : https://echanges.dila.gouv.fr/OPENDATA/KALI/
  - un dump global Freemium_kali_global_YYYYMMDD-HHMMSS.tar.gz (~173 Mo)
  - des increments quotidiens KALI_YYYYMMDD-HHMMSS.tar.gz (Ko a Mo)

Usage :
  python kali_sync.py            # telecharge le global (si absent) + tous les increments manquants
  python kali_sync.py --list     # affiche seulement ce qui serait telecharge

Etat : ab2pro-data/dila/kali/etat_sync.json (fichiers deja recuperes).
Les archives sont conservees telles quelles (pas d'extraction ici) ;
l'extraction/recherche est faite par kali_query.py qui lit les .tar.gz directement.
"""
import io, json, os, re, sys, urllib.request

BASE_URL = "https://echanges.dila.gouv.fr/OPENDATA/KALI/"
RACINE = os.path.join(os.path.expanduser("~"), "ab2pro-data", "dila", "kali")
DIR_INCR = os.path.join(RACINE, "increments")
ETAT = os.path.join(RACINE, "etat_sync.json")
UA = {"User-Agent": "Mozilla/5.0 (veille conventionnelle AB2Pro; contact wboussard@gmail.com)"}


def lister_depot():
    req = urllib.request.Request(BASE_URL, headers=UA)
    html = urllib.request.urlopen(req, timeout=60).read().decode("utf-8", "replace")
    globaux = sorted(set(re.findall(r'Freemium_kali_global_[\d-]+\.tar\.gz', html)))
    incrs = sorted(set(re.findall(r'KALI_[\d-]+\.tar\.gz', html)))
    return globaux, incrs


def telecharger(nom, dest):
    url = BASE_URL + nom
    tmp = dest + ".part"
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=600) as r, open(tmp, "wb") as f:
        while True:
            bloc = r.read(1 << 20)
            if not bloc:
                break
            f.write(bloc)
    os.replace(tmp, dest)
    return os.path.getsize(dest)


def main():
    apercu = "--list" in sys.argv
    os.makedirs(DIR_INCR, exist_ok=True)
    etat = {}
    if os.path.exists(ETAT):
        etat = json.load(open(ETAT, encoding="utf-8"))
    vus = set(etat.get("fichiers", []))

    globaux, incrs = lister_depot()
    if not globaux:
        print("ERREUR : aucun dump global trouve dans le listing", file=sys.stderr)
        sys.exit(1)
    dernier_global = globaux[-1]
    # increments STRICTEMENT posterieurs au dump global (datation dans le nom)
    date_glob = re.search(r'(\d{8}-\d{6})', dernier_global).group(1)
    utiles = [n for n in incrs if re.search(r'(\d{8}-\d{6})', n).group(1) > date_glob]

    a_faire = []
    chemin_glob = os.path.join(RACINE, dernier_global)
    if not os.path.exists(chemin_glob):
        a_faire.append((dernier_global, chemin_glob))
    for n in utiles:
        p = os.path.join(DIR_INCR, n)
        if n not in vus and not os.path.exists(p):
            a_faire.append((n, p))

    print(f"depot : global {dernier_global} + {len(utiles)} increments posterieurs ; a telecharger : {len(a_faire)}")
    if apercu:
        for n, _ in a_faire[:10]:
            print("  -", n)
        if len(a_faire) > 10:
            print(f"  ... et {len(a_faire) - 10} autres")
        return

    total = 0
    for k, (n, p) in enumerate(a_faire, 1):
        taille = telecharger(n, p)
        total += taille
        vus.add(n)
        if k % 25 == 0 or taille > 5 << 20:
            print(f"  [{k}/{len(a_faire)}] {n} ({taille/1e6:.1f} Mo)")
    json.dump({"fichiers": sorted(vus), "global": dernier_global},
              open(ETAT, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    print(f"TERMINE : {len(a_faire)} fichiers, {total/1e6:.1f} Mo — base locale a jour ({RACINE})")


if __name__ == "__main__":
    main()
