# -*- coding: utf-8 -*-
"""Interrogation de la base KALI locale (dumps DILA telecharges par kali_sync.py).

Les archives .tar.gz sont lues telles quelles ; un index id -> (archive, membre)
est construit une fois, la version la plus recente d'un meme id gagnant
(global < increments chronologiques). Les suppressions (liste_suppression) sont honorees.

Usage :
  python kali_query.py index                     # (re)construit index + carte conteneurs (apres kali_sync)
  python kali_query.py cont  3109                # IDCC -> conteneur(s) KALICONT (instantane)
  python kali_query.py textes KALICONT... "salaire|2026"  # liens du conteneur filtres par titre (regex)
  python kali_query.py get   KALITEXT0000...     # resume : metadonnees + extension + articles
  python kali_query.py get   KALIARTI0000...     # contenu texte d'un article
  python kali_query.py raw   KALITEXT0000...     # XML brut sur stdout (suffixe :struct = liste articles)
Note : si un tableau annexe manque dans KALI (« tableau joint »), le porteur authentique est le
BOCC — voir bocc_get.py (ORIGINE_PUBLI du XML version donne le numero de BO).
"""
import gzip, io, json, os, re, sys, tarfile
import xml.etree.ElementTree as ET

RACINE = os.path.join(os.path.expanduser("~"), "ab2pro-data", "dila", "kali")
DIR_INCR = os.path.join(RACINE, "increments")
INDEX = os.path.join(RACINE, "index.json.gz")
ID_RE = re.compile(r'(KALI(?:CONT|TEXT|ARTI)\d{12})\.xml$')


def archives_ordonnees():
    """global d'abord, puis increments par ordre chronologique (le plus recent ecrase)."""
    globs = sorted(f for f in os.listdir(RACINE) if f.startswith("Freemium_kali_global_") and f.endswith(".tar.gz"))
    incrs = sorted(f for f in os.listdir(DIR_INCR) if f.startswith("KALI_") and f.endswith(".tar.gz"))
    return [os.path.join(RACINE, f) for f in globs] + [os.path.join(DIR_INCR, f) for f in incrs]


def construire_index():
    """Index id -> (archive, membre) + carte IDCC -> conteneurs (conteneurs.json),
    construite au fil de l'eau : les XML de conteneurs (petits) sont lus pendant le passage."""
    idx, conts, supprimes = {}, {}, 0
    arcs = archives_ordonnees()
    for k, arc in enumerate(arcs, 1):
        rel = os.path.relpath(arc, RACINE)
        try:
            with tarfile.open(arc, "r:gz") as t:
                for m in t:
                    nom = m.name
                    if nom.endswith(".dat") and "suppression" in nom:
                        data = t.extractfile(m).read().decode("utf-8", "replace")
                        for ligne in data.splitlines():
                            mm = re.search(r'(KALI(?:CONT|TEXT|ARTI)\d{12})', ligne)
                            if mm and mm.group(1) in idx:
                                del idx[mm.group(1)]
                                conts.pop(mm.group(1), None)
                                supprimes += 1
                        continue
                    mm = ID_RE.search(nom)
                    if mm:
                        # un meme KALITEXT existe en deux exemplaires : texte/version (metadonnees)
                        # et texte/struct (liste des articles) — indexer les deux roles
                        cle = mm.group(1) + (":struct" if "/struct/" in nom else "")
                        idx[cle] = [rel, nom]
                        if cle.startswith("KALICONT"):
                            xml = t.extractfile(m).read()
                            num = re.search(br'<NUM>\s*(\d{1,5})\s*</NUM>', xml)
                            tit = re.search(br'<TITRE>([^<]{0,200})</TITRE>', xml)
                            eta = re.search(br'<ETAT>([^<]{0,40})</ETAT>', xml)
                            conts[cle] = {
                                "idcc": num.group(1).decode() if num else "",
                                "titre": (tit.group(1).decode("utf-8", "replace").strip() if tit else ""),
                                "etat": eta.group(1).decode() if eta else "",
                            }
        except Exception as e:
            print(f"  ! archive illisible {rel} : {e}", file=sys.stderr)
        if k % 40 == 0:
            print(f"  [{k}/{len(arcs)}] archives indexees, {len(idx)} ids")
    with gzip.open(INDEX, "wt", encoding="utf-8") as f:
        json.dump(idx, f, ensure_ascii=False)
    json.dump(conts, open(os.path.join(RACINE, "conteneurs.json"), "w", encoding="utf-8"),
              ensure_ascii=False, indent=0)
    print(f"INDEX : {len(idx)} ids, {len(conts)} conteneurs cartographies ({supprimes} suppressions) -> {INDEX}")


def charger_index():
    with gzip.open(INDEX, "rt", encoding="utf-8") as f:
        return json.load(f)


def extraire(ident, idx=None):
    """Extraction avec CACHE disque : chaque acces au grand tar global decompresse
    sequentiellement — on ne paye ce cout qu'une fois par id."""
    cache = os.path.join(RACINE, "cache", ident.replace(":", "_") + ".xml")
    if os.path.exists(cache):
        return open(cache, "rb").read()
    idx = idx or charger_index()
    if ident not in idx:
        raise KeyError(f"{ident} absent de l'index (refaire `index` apres un sync ?)")
    rel, membre = idx[ident]
    with tarfile.open(os.path.join(RACINE, rel), "r:gz") as t:
        data = t.extractfile(membre).read()
    os.makedirs(os.path.dirname(cache), exist_ok=True)
    with open(cache, "wb") as f:
        f.write(data)
    return data


def _txt(el, chemin, defaut=""):
    n = el.find(chemin)
    return (n.text or "").strip() if n is not None and n.text else defaut


def resume(ident):
    xml = extraire(ident)
    r = ET.fromstring(xml)
    if ident.startswith("KALICONT"):
        print("CONTENEUR :", _txt(r, ".//TITRE") or _txt(r, ".//TITREFULL"))
        print("Etat :", _txt(r, ".//ETAT_JURIDIQUE", "?"), "| IDCC :", " ".join(e.get("NUM", "") for e in r.iter() if e.tag == "IDCC") or _txt(r, ".//NUM"))
        n = 0
        for lien in r.iter():
            if lien.tag in ("LIEN_TXT", "TM_LIEN", "LIEN"):
                idt = lien.get("IDTXT") or lien.get("ID") or ""
                if idt.startswith("KALITEXT"):
                    n += 1
        print(f"({n} liens de textes — utiliser `textes {ident} <date>` pour filtrer)")
    elif ident.startswith("KALITEXT"):
        print("TEXTE :", _txt(r, ".//TITREFULL") or _txt(r, ".//TITRE"))
        print("Nature :", _txt(r, ".//META_COMMUN/NATURE", "?"), "| date :", _txt(r, ".//DATE_TEXTE", "?"),
              "| effet :", _txt(r, ".//DATE_DEBUT", "?"), "| etat :", _txt(r, ".//ETAT", "?"))
        ext = _txt(r, ".//LIBELLE_EXTENSION")
        if ext:
            print("Extension :", ext)
        # les articles sont dans l'exemplaire texte/struct du meme id
        try:
            rs = ET.fromstring(extraire(ident + ":struct"))
            arts = [(l.get("id") or l.get("ID"), l.get("titre") or l.get("TITRE") or "",
                     l.get("etat") or l.get("ETAT") or "") for l in rs.iter("LIEN_ART")]
            print(f"{len(arts)} article(s) :")
            for aid, tit, etat in arts:
                print("  -", aid, f"[{etat}]", tit[:90])
        except KeyError:
            print("(pas d'exemplaire struct dans l'index)")
    elif ident.startswith("KALIARTI"):
        print("ARTICLE :", _txt(r, ".//NUM", "(sans numero)"), "| etat :", _txt(r, ".//ETAT_JURIDIQUE", "?"))
        bloc = r.find(".//BLOC_TEXTUEL/CONTENU")
        if bloc is not None:
            brut = ET.tostring(bloc, encoding="unicode", method="text")
            print(re.sub(r'\n{3,}', "\n\n", brut).strip()[:12000])
        else:
            print("(pas de BLOC_TEXTUEL)")


def textes_du_conteneur(ident, motif):
    """Liste les LIEN_TXT du conteneur dont le TITRE matche `motif` (regex, insensible casse) ;
    pour chaque match, va chercher date/etat/extension dans le XML version du texte."""
    idx = charger_index()
    r = ET.fromstring(extraire(ident, idx))
    vus = set()
    n = 0
    for lien in r.iter("LIEN_TXT"):
        idt = lien.get("idtxt") or lien.get("IDTXT") or ""
        titre = lien.get("titretxt") or lien.get("TITRE") or ""
        if not idt.startswith("KALITEXT") or idt in vus:
            continue
        vus.add(idt)
        if motif and not re.search(motif, titre, re.I):
            continue
        n += 1
        date, etat, ext = "?", "?", ""
        try:
            rv = ET.fromstring(extraire(idt, idx))
            date = _txt(rv, ".//DATE_TEXTE", "?")
            etat = _txt(rv, ".//ETAT", "?")
            ext = _txt(rv, ".//LIBELLE_EXTENSION")
        except KeyError:
            pass
        print(f"{date}  {idt}  [{etat}]  {titre[:100]}" + (f"  — {ext}" if ext else ""))
    print(f"({n} texte(s) sur {len(vus)} liens ; motif : {motif or 'aucun'})")


def conteneurs_pour_idcc(idcc):
    """IDCC -> conteneur(s) via la carte conteneurs.json construite a l'indexation
    (la base elle-meme fait foi — le xlsx DILA de 2023 ignore les CCN recentes type 7028)."""
    chemin = os.path.join(RACINE, "conteneurs.json")
    conts = json.load(open(chemin, encoding="utf-8"))
    cible = str(idcc)
    trouves = [(k, v) for k, v in conts.items() if v.get("idcc") == cible]
    for k, v in sorted(trouves):
        print(k, "|", v.get("etat", "?"), "|", v.get("titre", "")[:110])
    if not trouves:
        print(f"(aucun conteneur pour IDCC {cible} dans la carte — refaire `index` ?)")


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else ""
    if cmd == "index":
        construire_index()
    elif cmd == "get":
        resume(sys.argv[2])
    elif cmd == "raw":
        sys.stdout.buffer.write(extraire(sys.argv[2]))
    elif cmd == "textes":
        textes_du_conteneur(sys.argv[2], sys.argv[3] if len(sys.argv) > 3 else "")
    elif cmd == "cont":
        conteneurs_pour_idcc(sys.argv[2])
    else:
        print(__doc__)
