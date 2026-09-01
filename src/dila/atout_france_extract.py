# -*- coding: utf-8 -*-
"""Plan B hebergement d'equipes : etablissements CLASSES Atout France
(residences de tourisme, villages vacances, auberges collectives, parcs
residentiels de loisirs) geocodes via la Base Adresse Nationale.

Source : CSV quotidien Atout France (data.gouv, Licence Ouverte,
ressource stable r/3ce290bf-07ec-4d63-b12b-d0496193a535) — adresse/commune/
capacite/classement, SANS lat/lon ni contact : geocodage BAN par lots
(api-adresse.data.gouv.fr/search/csv/), contact retrouvable via site web/Maps.

Usage :
  python atout_france_extract.py   # lit ~/ab2pro-data/datatourisme/atout-france.csv
Sortie : src/auth/assets/app/data/dt/af.json
  entrees : [nom, commune, cp, lat, lon, capacite, classement, typologie, site, dateClassement]
"""
import csv, io, json, os, sys, urllib.request, uuid

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
SRC = os.path.expanduser(r"~\ab2pro-data\datatourisme\atout-france.csv")
DEST = os.path.expanduser(r"~\ab2pro-repo\src\auth\assets\app\data\dt\af.json")
TYPOS = {"RÉSIDENCE DE TOURISME": "Résidence de tourisme", "VILLAGE DE VACANCES": "Village de vacances",
         "AUBERGE COLLECTIVE": "Auberge collective", "PARC RÉSIDENTIEL DE LOISIRS": "PRL (mobil-homes)"}


def geocode_lot(lignes):
    """BAN /search/csv : POST multipart d'un CSV (colonnes q = adresse complete) -> lat/lon."""
    corps = io.StringIO()
    w = csv.writer(corps)
    w.writerow(["q"])
    for l in lignes:
        w.writerow([f"{l['adresse']} {l['cp']} {l['commune']}"])
    frontiere = uuid.uuid4().hex
    data = ("--" + frontiere + "\r\n"
            'Content-Disposition: form-data; name="data"; filename="lot.csv"\r\n'
            "Content-Type: text/csv\r\n\r\n" + corps.getvalue() + "\r\n"
            "--" + frontiere + "\r\n"
            'Content-Disposition: form-data; name="columns"\r\n\r\nq\r\n'
            "--" + frontiere + "--\r\n").encode("utf-8")
    req = urllib.request.Request("https://api-adresse.data.gouv.fr/search/csv/", data=data,
                                 headers={"Content-Type": "multipart/form-data; boundary=" + frontiere,
                                          "User-Agent": "AB2Pro logements"})
    rep = urllib.request.urlopen(req, timeout=300).read().decode("utf-8")
    lecteur = csv.DictReader(io.StringIO(rep))
    for l, r in zip(lignes, lecteur):
        try:
            l["lat"] = round(float(r.get("latitude") or ""), 5)
            l["lon"] = round(float(r.get("longitude") or ""), 5)
        except ValueError:
            l["lat"] = l["lon"] = None
    return lignes


def main():
    lignes = []
    with open(SRC, encoding="utf-8-sig", newline="") as f:
        for row in csv.DictReader(f, delimiter=";"):
            typo = (row.get("TYPOLOGIE ÉTABLISSEMENT") or "").strip()
            if typo not in TYPOS:
                continue
            cp = (row.get("CODE POSTAL") or "").strip()
            if not cp or cp.startswith("97"):
                continue
            capa = (row.get("CAPACITÉ D'ACCUEIL (PERSONNES)") or "").replace("-", "").strip()
            lignes.append({
                "nom": (row.get("NOM COMMERCIAL") or "").strip()[:90],
                "adresse": (row.get("ADRESSE") or "").replace("-", " ").strip()[:90],
                "cp": cp, "commune": (row.get("COMMUNE") or "").strip()[:40],
                "capa": capa[:5], "cls": (row.get("CLASSEMENT") or "").strip()[:12],
                "typo": TYPOS[typo],
                "site": (row.get("SITE INTERNET") or "").replace("-", "").strip()[:120],
                "date": (row.get("DATE DE CLASSEMENT") or "").strip()[:10],
            })
    print(f"{len(lignes)} etablissements plan B a geocoder (BAN, lots de 800)")
    ok = 0
    for i in range(0, len(lignes), 800):
        lot = lignes[i:i + 800]
        geocode_lot(lot)
        ok += sum(1 for l in lot if l.get("lat") is not None)
        print(f"  [{min(i + 800, len(lignes))}/{len(lignes)}] geocodes ok : {ok}")
    garde = [[l["nom"], l["commune"], l["cp"], l["lat"], l["lon"], l["capa"], l["cls"],
              l["typo"], l["site"], l["date"]]
             for l in lignes if l.get("lat") is not None]
    json.dump({"maj": "2026-09-02", "source": "Atout France (Licence Ouverte) — geocodage BAN",
               "n": len(garde), "h": garde},
              open(DEST, "w", encoding="utf-8"), ensure_ascii=False, separators=(",", ":"))
    print(f"TERMINE : {len(garde)} etablissements geocodes -> {DEST} ({os.path.getsize(DEST)/1e3:.0f} Ko)")


if __name__ == "__main__":
    main()
