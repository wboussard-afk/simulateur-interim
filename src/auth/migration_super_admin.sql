PRAGMA defer_foreign_keys = true;
-- ===== Migration : rôle super_admin (SQLite ne modifie pas un CHECK → reconstruction) =====
CREATE TABLE utilisateurs_v2 (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  nom TEXT NOT NULL DEFAULT '',
  sel TEXT NOT NULL,
  hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user','admin','super_admin')),
  actif INTEGER NOT NULL DEFAULT 1,
  doit_changer_mdp INTEGER NOT NULL DEFAULT 0,
  echecs INTEGER NOT NULL DEFAULT 0,
  verrou_jusqua INTEGER NOT NULL DEFAULT 0,
  invite_token TEXT,
  invite_expire INTEGER,
  cree_le TEXT NOT NULL DEFAULT (datetime('now')),
  cree_par TEXT NOT NULL DEFAULT 'seed'
);
INSERT INTO utilisateurs_v2 (id, email, nom, sel, hash, role, actif, doit_changer_mdp, echecs, verrou_jusqua, invite_token, invite_expire, cree_le, cree_par)
  SELECT id, email, nom, sel, hash, role, actif, doit_changer_mdp, echecs, verrou_jusqua, invite_token, invite_expire, cree_le, cree_par FROM utilisateurs;
DROP TABLE utilisateurs;
ALTER TABLE utilisateurs_v2 RENAME TO utilisateurs;
UPDATE utilisateurs SET role = 'super_admin' WHERE email IN ('wboussard@gmail.com','urgensv@gmail.com');

