# -*- coding: utf-8 -*-
"""Fusionne les fiche_ml_*.json (une par IDCC) dans fiches_mainloop.json (idcc = clé, remplace si présent)."""
import json, io, sys, glob, os
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')
base = r"C:\Users\NatassaMarkopoulou\AppData\Local\Temp\claude\C--Users-NatassaMarkopoulou-OneDrive---Magen-Financial-LLC-Desktop\ab66d73f-efe1-40d7-96f5-62b4be56e0df\scratchpad"
p = base + r"\fiches_mainloop.json"
d = json.load(open(p, encoding='utf-8'))
by_idcc = {f["idcc"]: f for f in d["fiches"]}
for fp in sorted(glob.glob(base + r"\fiche_ml_*.json")):
    f = json.load(open(fp, encoding='utf-8'))
    by_idcc[f["idcc"]] = f
    print("fusionnée:", f["idcc"], "-", len(f["themes"]), "thèmes  (", os.path.basename(fp), ")")
d["fiches"] = list(by_idcc.values())
json.dump(d, open(p, "w", encoding='utf-8'), ensure_ascii=False, indent=1)
print("total fiches mainloop:", len(d["fiches"]), "| remplacements:", len(d.get("remplacements", [])))
