-- 04/09/2026 : prénom séparé du nom (inscription sur deux lignes ; nom = nom de famille pour les nouveaux comptes,
-- les comptes existants gardent leur nom complet dans nom avec prenom NULL)
ALTER TABLE utilisateurs ADD COLUMN prenom TEXT;
ALTER TABLE demandes_acces ADD COLUMN prenom TEXT;
