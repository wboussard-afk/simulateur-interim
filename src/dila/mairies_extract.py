# -*- coding: utf-8 -*-
"""Annuaire DILA (api-lannuaire.service-public.fr, Licence Ouverte) -> data/mairies.json
compact pour l'envoi automatique des demandes CADA : cle "nom-normalise|dep" -> e-mail.

Source : export JSON du dataset api-lannuaire-administration filtre pivot mairie
(~35 000 mairies, ~7 Mo). Le nom DILA est « Mairie - <Commune> » ; le departement
vient du code INSEE (2 premiers caracteres, 2A/2B pour la Corse).
Usage : python mairies_extract.py   (lit ~/ab2pro-data/mairies_export.json)
Sortie : src/auth/assets/app/data/mairies.json  (donnees publiques, committables)
"""
import io, json, os, re, sys, unicodedata

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8", errors="replace")
SRC = os.path.expanduser(r"~\ab2pro-data\mairies_export.json")
DEST = os.path.expanduser(r"~\ab2pro-repo\src\auth\assets\app\data\mairies.json")


def norm(s):
    """meme normalisation que la page logements (norm JS) : minuscules sans accents ni ponctuation"""
    s = unicodedata.normalize("NFD", s or "").lower()
    return re.sub(r"[^a-z0-9]", "", s)


def dep_de_insee(insee):
    if not insee or len(insee) < 2:
        return None
    if insee[:2] == "97":
        return None  # metropole + Corse uniquement (perimetre chantiers)
    if insee[:2] == "20" or insee[:2] in ("2A", "2B"):
        return insee[:2] if insee[:2] in ("2A", "2B") else None
    return insee[:2]


def main():
    data = json.load(open(SRC, encoding="utf-8"))
    mairies, doublons = {}, set()
    sans_email = 0
    for m in data:
        nom = (m.get("nom") or "")
        if not nom.lower().startswith("mairie"):
            continue  # ecarte mairies annexes/deleguees aux intitules speciaux ? non: elles commencent aussi par Mairie...
        # mairies deleguees : « Mairie deleguee - X » -> on les garde en secours (ecrasees par la principale si presente)
        deleguee = "délégu" in nom.lower() or "delegu" in nom.lower()
        commune = re.sub(r"^mairie( d[ée]l[ée]gu[ée]e)?\s*-\s*", "", nom, flags=re.I).strip()
        email = (m.get("adresse_courriel") or "").strip().lower()
        # certains enregistrements portent plusieurs adresses separees par ; ou , -> premiere
        email = re.split(r"[;,\s]+", email)[0] if email else ""
        if not email or "@" not in email:
            sans_email += 1
            continue
        dep = dep_de_insee(m.get("code_insee_commune") or "")
        if not dep:
            continue
        cle = norm(commune) + "|" + dep
        if cle in mairies:
            if deleguee:
                continue          # la principale gagne
            doublons.add(cle)
        mairies[cle] = email
    json.dump({"maj": "2026-09-03", "source": "Annuaire de l'administration (DILA, Licence Ouverte 2.0)",
               "n": len(mairies), "m": mairies},
              open(DEST, "w", encoding="utf-8"), ensure_ascii=False, separators=(",", ":"))
    print(f"TERMINE : {len(data)} enregistrements -> {len(mairies)} mairies avec e-mail "
          f"({sans_email} sans e-mail, {len(doublons)} doublons ecrases), "
          f"{os.path.getsize(DEST)/1e6:.1f} Mo -> {DEST}")


if __name__ == "__main__":
    main()
