# -*- coding: utf-8 -*-
"""Extraction des HEBERGEMENTS LOCATIFS de DATAtourisme (dump national JSON-LD)
vers des fichiers par departement pour la section Recherche Logements.

Source : dump national quotidien (miroir data.cquest.org reference sur data.gouv,
Licence Ouverte 2.0 Etalab — reutilisation commerciale licite AVEC attribution :
source/createur + date de mise a jour affichees sur chaque fiche).
Verifie le 01/09/2026 : ~369 000 lieux dont ~98 000 RentalAccommodation,
~71 pct avec telephone ou email dans hasContact.

Usage :
  python datatourisme_extract.py            # lit ~/ab2pro-data/datatourisme/lieux.json.gz
Sorties :
  src/auth/assets/app/data/dt/<dep>.json    (proteges par l'auth du portail, .gitignore)
  — entrees : [nom, commune, cp, lat, lon, capacite, classement, tel, email, site, createur, maj]
"""
import gzip, io, json, os, re, sys

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
SRC = os.path.expanduser(r"~\ab2pro-data\datatourisme\lieux.json.gz")
DEST = os.path.expanduser(r"~\ab2pro-repo\src\auth\assets\app\data\dt")


def txt(v):
    """Valeur JSON-LD -> texte : chaine, {@value}, liste, dict multilingue {fr:...}."""
    if v is None:
        return ""
    if isinstance(v, str):
        return v.strip()
    if isinstance(v, list):
        for x in v:
            t = txt(x)
            if t:
                return t
    if isinstance(v, dict):
        if "@value" in v:
            return txt(v["@value"])
        if "fr" in v:
            return txt(v["fr"])
        for x in v.values():
            t = txt(x)
            if t:
                return t
    return ""


def premiers(v):
    return v if isinstance(v, list) else ([v] if v is not None else [])


def extraire_poi(poi):
    types = premiers(poi.get("@type"))
    if "RentalAccommodation" not in types:
        return None
    # localisation
    lat = lon = None
    adresse = {}
    for loc in premiers(poi.get("isLocatedAt")):
        if not isinstance(loc, dict):
            continue
        geo = loc.get("schema:geo") or {}
        try:
            lat = float(txt(geo.get("schema:latitude")))
            lon = float(txt(geo.get("schema:longitude")))
        except (TypeError, ValueError):
            pass
        for adr in premiers(loc.get("schema:address")):
            if isinstance(adr, dict):
                adresse = adr
                break
        if lat is not None:
            break
    cp = txt(adresse.get("schema:postalCode"))
    commune = txt(adresse.get("schema:addressLocality"))
    if lat is None or lon is None or not cp:
        return None
    dep = cp[:2]
    if dep == "20":
        dep = "2A" if cp[:3] <= "201" else "2B"
    if dep.startswith("97"):
        return None  # metropole + Corse uniquement (perimetre chantiers)
    # contact designe du POI (JAMAIS hasBeenCreatedBy — c'est le producteur de la donnee)
    tel = mail = site = ""
    for c in premiers(poi.get("hasContact")):
        if not isinstance(c, dict):
            continue
        tel = tel or txt(c.get("schema:telephone"))
        mail = mail or txt(c.get("schema:email"))
        site = site or txt(c.get("foaf:homepage") or c.get("schema:url"))
    capacite = txt(poi.get("allowedPersons")) or ""
    classement = ""
    for r in premiers(poi.get("hasReview")):
        if isinstance(r, dict):
            classement = txt(r.get("hasReviewValue") or r.get("rdfs:label"))
            if classement:
                break
    createur = ""
    cb = poi.get("hasBeenCreatedBy")
    if isinstance(cb, dict):
        createur = txt(cb.get("schema:legalName") or cb.get("rdfs:label"))
    maj = txt(poi.get("lastUpdate") or poi.get("lastUpdateDatatourisme"))[:10]
    nom = txt(poi.get("rdfs:label"))
    if not nom:
        return None
    tel = re.sub(r"[^\d+]", "", tel)[:16]
    return dep, [nom[:90], commune[:40], cp, round(lat, 5), round(lon, 5),
                 capacite[:4], classement[:20], tel, mail[:60], site[:120],
                 createur[:60], maj]


def main():
    os.makedirs(DEST, exist_ok=True)
    par_dep, total, gardes = {}, 0, 0
    # le dump est un JSON-LD géant : un objet par ligne n'est pas garanti — on
    # streame et découpe sur les objets de premier niveau du tableau @graph
    dec = json.JSONDecoder()
    with gzip.open(SRC, "rt", encoding="utf-8") as f:
        buf = f.read(1 << 20)
        # aller au tableau @graph
        i = buf.find("[")
        pos = i + 1
        while True:
            # sauter separateurs
            while pos < len(buf) and buf[pos] in " \t\r\n,":
                pos += 1
            if pos > len(buf) - (1 << 19):
                suite = f.read(1 << 22)
                buf = buf[pos:] + suite
                pos = 0
                if not suite and not buf.strip(" \t\r\n,]"):
                    break
            if pos < len(buf) and buf[pos] == "]":
                break
            try:
                poi, fin = dec.raw_decode(buf, pos)
            except json.JSONDecodeError:
                suite = f.read(1 << 22)
                if not suite:
                    break
                buf = buf[pos:] + suite
                pos = 0
                continue
            pos = fin
            total += 1
            r = extraire_poi(poi) if isinstance(poi, dict) else None
            if r:
                dep, ligne = r
                par_dep.setdefault(dep, []).append(ligne)
                gardes += 1
            if total % 50000 == 0:
                print(f"  {total} lieux lus, {gardes} hebergements retenus")
    date_dump = "2026-09-02"
    for dep, lignes in par_dep.items():
        lignes.sort(key=lambda x: (x[1], x[0]))
        json.dump({"maj": date_dump, "source": "DATAtourisme (Licence Ouverte 2.0 — attribution par fiche)",
                   "n": len(lignes), "h": lignes},
                  open(os.path.join(DEST, f"{dep}.json"), "w", encoding="utf-8"),
                  ensure_ascii=False, separators=(",", ":"))
    tailles = sum(os.path.getsize(os.path.join(DEST, f)) for f in os.listdir(DEST))
    avec_tel = sum(1 for l in par_dep.values() for x in l if x[7])
    avec_mail = sum(1 for l in par_dep.values() for x in l if x[8])
    print(f"TERMINE : {total} lieux -> {gardes} hebergements locatifs, {len(par_dep)} departements, "
          f"{tailles/1e6:.1f} Mo ; tel {avec_tel}, mail {avec_mail}")


if __name__ == "__main__":
    main()
