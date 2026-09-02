-- ===== Migration 02/09/2026 : entités AB2Pro / AB Service + agences de rattachement =====
-- AB Service est une entité à part : chaque utilisateur appartient à une entité
-- ('ab2pro' ou 'abservice' ; NULL = ab2pro, comptes historiques) et, côté AB Service,
-- à une ou plusieurs agences (tableau JSON de slugs — voir AGENCES_ABSERVICE dans worker.js).
-- Les réponses des logeurs sont routées vers l'e-mail perso + les boîtes génériques des agences.
ALTER TABLE utilisateurs ADD COLUMN entite TEXT;
ALTER TABLE utilisateurs ADD COLUMN agences TEXT;
ALTER TABLE demandes_acces ADD COLUMN entite TEXT;
ALTER TABLE demandes_acces ADD COLUMN agences TEXT;
