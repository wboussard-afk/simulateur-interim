# -*- coding: utf-8 -*-
"""Genere la table IDCC_TOUS = {idcc: [titre court | "", secteur | 0]} et l'injecte
dans conventions.html entre /*IDCC_TOUS_DEBUT*/ et /*IDCC_TOUS_FIN*/.
Sources :
 - Titres : liste officielle DILA/KALI (xlsx, conventions EN VIGUEUR uniquement) ;
 - Secteurs : mots-cles du titre officiel, sinon section NAF DOMINANTE observee
   (CSV data.gouv 'conventions collectives appliquees par departement et secteur').
Usage : python gen_idcc_tous.py <dila.xlsx> <naf.csv> <conventions.html>"""
import sys, re, json, io, csv, collections
import openpyxl

xlsx, naf_csv, html_path = sys.argv[1], sys.argv[2], sys.argv[3]

# ---- 1. titres officiels (DILA, etat VIGUEUR*) ----
wb = openpyxl.load_workbook(xlsx, read_only=True)
ws = wb.worksheets[0]
titres = {}
for row in ws.iter_rows(min_row=5, values_only=True):
    _, kid, cc_ti, idcc, titre, nature, etat, *_ = row
    if cc_ti != "IDCC" or not idcc or not titre or not etat:
        continue
    if not str(etat).startswith("VIGUEUR"):
        continue
    n = int(idcc)
    if n not in titres:
        titres[n] = str(titre).strip()

def court(t):
    t = re.sub(r"^Convention collective\s+(nationale|r[ée]gionale|d[ée]partementale|interr[ée]gionale)?\s*", "", t, flags=re.I)
    t = re.sub(r"^(de la |de l'|du |des |de |d'|pour les |pour la |pour le |pour l'|concernant (les |la |le |l')?|applicable (aux |au |à la |à l')?)", "", t, flags=re.I)
    t = re.sub(r"\s+du \d{1,2}(er)?\s+\S+\s+\d{4}.*$", "", t)
    t = re.sub(r"\s*[-–]\s*[EÉ]tendue? par arr[êe]t[ée].*$", "", t, flags=re.I)
    t = re.sub(r"\s*\(anciennement.*?\)\s*", " ", t, flags=re.I)
    t = re.sub(r"\s*\((accord|avenant|réécrite).*$", "", t, flags=re.I)
    t = re.sub(r"\s*\.\s*(En vigueur|Mise à jour|Etendue).*$", "", t, flags=re.I)
    t = t.strip(" -–,;.")
    if re.match(r"^Accord collectif", t, flags=re.I) or len(t) < 8:
        return ""                     # titre vide de sens apres nettoyage → repli NAF
    return (t[0].upper() + t[1:])[:110]

# ---- 2. secteur par mots-cles du titre (premier motif gagnant) ----
REGLES = [
    ("Intérim", ["travail temporaire"]),
    ("BTP", ["bâtiment", "batiment", "travaux publics"]),
    ("Industrie — métallurgie", ["métallurgie", "sidérurgie"]),
    ("Industrie — chimie", ["chimi", "pétrol", "caoutchouc"]),
    ("Protection sociale", ["sécurité sociale", "retraite complémentaire", "pôle emploi", "régime social des indépendants",
        "régime général", "missions locales"]),
    ("Culture — médias", ["cinématograph", "spectacle", "audiovisuel", "télévision", "radiodiff", "télédiff", "presse",
        "édition", "artistiques", "journalistes", "photographie", "phonographique"]),
    ("Banque-assurance", ["banque", "assurance", "mutualité", "mutuelles", "crédit", "financ"]),
    ("Commerce", ["commerce", "négoce", "succursale", "grands magasins", "détaillant", "de détail", "de gros",
        "distribut", "expédi", "jardinerie", "bricolage", "librairie"]),
    ("Industrie agroalimentaire", ["aliment", "boulanger", "pâtiss", "viande", "laiti", "sucre", "conserve", "céréale",
        "grains", "vins", "cidre", "spiritueux", "glaces", "biscuit", "biscot", "chocolat", "confiserie", "charcut",
        "poisson", "volaille", "abattoir", "meunerie", "huil", "brasserie", "boissons", "œufs", "oeufs"]),
    ("Agricole", ["agricole", "agricult", "exploitations agricoles", "polyculture", "élevage", "maraîch", "horticol",
        "paysag", "forest", "sylvic", "cuma", "teillage", "déshydratation", "conchylic", "pêche", "aquacult",
        "vitico", "vinico"]),
    ("Transport — logistique", ["transport", "logistique", "déménagement", "navigation", "aérien", "portuaire",
        "manutention", "routier"]),
    ("Hôtellerie-restauration", ["hôtel", "restaur", "café", "tourisme", "casino", "traiteur"]),
    ("Services — propreté", ["propreté", "nettoyage"]),
    ("Services — sécurité", ["sécurité", "prévention"]),
    ("Services — automobile", ["automobile", "cycles et motocycles"]),
    ("Santé", ["santé", "pharmac", "médic", "hospital", "clinique", "dentaire", "vétérinaire", "laboratoire",
        "infirmier", "thermal"]),
    ("Tertiaire — immobilier", ["immobili"]),
    ("Tertiaire", ["bureaux d'études", "conseil", "expert", "informatique", "avocat", "notari", "huissier",
        "architect", "publicité", "télécommunication", "prestataires de services"]),
    ("Industrie", ["industrie", "manufactur", "plasturgie", "textile", "papier", "carton", "verre", "céramique",
        "bois", "ameublement", "imprimerie", "fonderie", "électronique", "électrique", "mécanique", "chaux",
        "ciment", "carrières", "matériaux", "production", "fabrication"]),
]
def secteur_titre(t):
    b = t.lower()
    for nom, mots in REGLES:
        if any(m in b for m in mots):
            return nom
    return None

# ---- 3. secteur empirique : section NAF dominante par IDCC (donnees d'application reelles) ----
NAF_SECTEUR = { "A": "Agricole", "B": "Industrie", "C": "Industrie", "D": "Industrie — énergie",
    "E": "Industrie", "F": "BTP", "G": "Commerce", "H": "Transport — logistique",
    "I": "Hôtellerie-restauration", "J": "Tertiaire", "K": "Banque-assurance",
    "L": "Tertiaire — immobilier", "M": "Tertiaire", "N": "Services", "O": "Secteur public",
    "P": "Enseignement", "Q": "Santé", "R": "Culture-loisirs", "S": "Services", "T": "Services à la personne" }
tot = collections.Counter(); par = collections.defaultdict(collections.Counter)
with io.open(naf_csv, encoding="utf-8") as f:
    for r in csv.DictReader(f):
        n = r["code_idcc"].strip()
        if not n.isdigit() or n in ("9999", "9998", "0"):
            continue
        c = int(r["nb_entreprises"])
        tot[int(n)] += c; par[int(n)][r["section_naf"]] += c
def secteur_naf(n):
    if n not in par or tot[n] < 10:
        return None
    sec, _ = par[n].most_common(1)[0]
    return NAF_SECTEUR.get(sec)

# ---- 4. fusion ----
table = {}
for n in sorted(set(titres) | set(k for k in tot if tot[k] >= 10)):
    t = court(titres[n]) if n in titres else ""
    s = (secteur_titre(t) if t else None) or (secteur_titre(titres[n]) if n in titres else None) or secteur_naf(n)
    table[n] = [t, s if s else 0]

js = "const IDCC_TOUS = " + json.dumps(table, ensure_ascii=False, separators=(",", ":")) + ";"
with io.open(html_path, "r", encoding="utf-8") as f:
    html = f.read()
deb, fin = "/*IDCC_TOUS_DEBUT*/", "/*IDCC_TOUS_FIN*/"
i, j = html.find(deb), html.find(fin)
if i < 0 or j < 0:
    sys.exit("marqueurs IDCC_TOUS introuvables dans " + html_path)
html = html[:i + len(deb)] + "\n" + js + "\n" + html[j:]
with io.open(html_path, "w", encoding="utf-8", newline="\n") as f:
    f.write(html)
avec_titre = sum(1 for v in table.values() if v[0])
avec_sect = sum(1 for v in table.values() if v[1] != 0)
print("IDCC_TOUS :", len(table), "codes ;", avec_titre, "avec titre officiel ;", avec_sect, "avec secteur ;",
      "16:", table.get(16), "; 1090:", table.get(1090), "; 7025:", table.get(7025))
