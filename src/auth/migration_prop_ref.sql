-- 05/09/2026 : commande saisie à la main sur une proposition (n° non présent dans la liste publiée)
ALTER TABLE propositions ADD COLUMN commande_ref TEXT;
