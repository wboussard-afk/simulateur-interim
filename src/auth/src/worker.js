/* ===== AB2Pro — Worker d'authentification, rôles et journal d'activité =====
 * Protège les 3 applications (simulateur, Veille Paie, Veille Conventions) + portail.
 * D1 : utilisateurs, sessions, demandes_acces, activites (voir schema.sql).
 * E-mails immédiats aux admins via Resend (secret RESEND_API_KEY).
 * Les fichiers statiques (assets/) ne sont servis qu'après session valide. */

const ADMINS = ["wboussard@gmail.com", "urgensv@gmail.com"];
const SESSION_MS = 12 * 3600 * 1000;       // 12 h glissantes
const INVITE_MS = 72 * 3600 * 1000;        // lien d'invitation 72 h
const PBKDF2_ITER = 100000;

/* ---------- utilitaires ---------- */
const hex = b => [...new Uint8Array(b)].map(x => x.toString(16).padStart(2, "0")).join("");
const unhex = s => new Uint8Array(s.match(/../g).map(x => parseInt(x, 16)));
const alea = n => hex(crypto.getRandomValues(new Uint8Array(n)));

async function pbkdf2(motdepasse, selHex) {
  const cle = await crypto.subtle.importKey("raw", new TextEncoder().encode(motdepasse), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: unhex(selHex), iterations: PBKDF2_ITER, hash: "SHA-256" }, cle, 256);
  return hex(bits);
}
function egaliteConstante(a, b) {
  if (a.length !== b.length) return false;
  let r = 0; for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}
const json = (o, status = 200, entetes = {}) =>
  new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json; charset=utf-8", ...entetes } });
const cookieSession = (token, maxAge) =>
  `session=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${maxAge}`;

/* Envoi INDIVIDUEL par destinataire : un refus (ex. mode test Resend limité au titulaire
 * du compte) ne bloque pas les autres ; chaque échec est journalisé et visible dans /admin. */
async function envoyerEmail(env, dest, sujet, texte, journalCtx) {
  const dests = Array.isArray(dest) ? dest : [dest];
  const resultats = [];
  for (const d of dests) {
    if (!env.RESEND_API_KEY) { resultats.push({ dest: d, ok: false, status: 0, corps: "RESEND_API_KEY absent" }); continue; }
    try {
      const r = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { authorization: `Bearer ${env.RESEND_API_KEY}`, "content-type": "application/json" },
        body: JSON.stringify({ from: env.EMAIL_FROM || "AB2Pro <onboarding@resend.dev>",
                               to: [d], subject: sujet, text: texte }),
      });
      const corps = await r.text().catch(() => "");
      resultats.push({ dest: d, ok: r.ok, status: r.status, corps: corps.slice(0, 300) });
    } catch (e) { resultats.push({ dest: d, ok: false, status: -1, corps: String(e).slice(0, 200) }); }
  }
  if (journalCtx) {
    for (const r of resultats) {
      if (!r.ok) await journal(journalCtx.env, journalCtx.req, null, "email_echec",
        r.dest + " [" + r.status + "] " + r.corps, sujet.slice(0, 80));
    }
  }
  return resultats;
}

async function journal(env, req, u, type, details = "", page = "") {
  try {
    await env.DB.prepare(
      "INSERT INTO activites (user_id, email, type, details, page, ip) VALUES (?,?,?,?,?,?)")
      .bind(u ? u.id : null, u ? u.email : "", type, String(details).slice(0, 500), String(page).slice(0, 200),
            req.headers.get("cf-connecting-ip") || "").run();
  } catch (e) { /* le journal ne doit jamais casser une requête */ }
}

async function utilisateurDeSession(env, req) {
  const m = (req.headers.get("cookie") || "").match(/(?:^|;\s*)session=([0-9a-f]{64})/);
  if (!m) return null;
  const r = await env.DB.prepare(
    "SELECT u.id, u.email, u.nom, u.role, u.actif, u.doit_changer_mdp, s.token, s.expire_le " +
    "FROM sessions s JOIN utilisateurs u ON u.id = s.user_id WHERE s.token = ?").bind(m[1]).first();
  if (!r || !r.actif || r.expire_le < Date.now()) return null;
  if (r.expire_le < Date.now() + SESSION_MS / 2)   // prolongation glissante
    await env.DB.prepare("UPDATE sessions SET expire_le = ? WHERE token = ?").bind(Date.now() + SESSION_MS, r.token).run();
  return r;
}

/* ---------- point d'entrée ---------- */
export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const p = url.pathname;
    const u = await utilisateurDeSession(env, req);

    /* --- API --- */
    if (p.startsWith("/api/")) return api(req, env, url, u);

    /* --- pages publiques : connexion / demande d'accès / définir mot de passe --- */
    if (p === "/" || p === "/index.html") {
      if (u && !u.doit_changer_mdp) return Response.redirect(url.origin + "/app/", 302);
      return env.ASSETS.fetch(new Request(url.origin + "/index.html", req));
    }
    if (p === "/motdepasse.html")
      return env.ASSETS.fetch(new Request(url.origin + "/motdepasse.html", req));

    /* --- panneau admin --- */
    if (p === "/admin" || p === "/admin.html") {
      if (!u) return Response.redirect(url.origin + "/", 302);
      if (u.role !== "admin") return new Response("Accès réservé aux administrateurs.", { status: 403 });
      return env.ASSETS.fetch(new Request(url.origin + "/admin.html", req));
    }

    /* --- applications protégées --- */
    if (p === "/app" || p.startsWith("/app/")) {
      if (!u) return Response.redirect(url.origin + "/?suite=" + encodeURIComponent(p), 302);
      if (u.doit_changer_mdp) return Response.redirect(url.origin + "/motdepasse.html", 302);
      const cible = (p === "/app" || p === "/app/") ? "/app/index.html" : p;
      const rep = await env.ASSETS.fetch(new Request(url.origin + cible, req));
      const ct = rep.headers.get("content-type") || "";
      if (rep.ok && ct.includes("text/html")) {
        await journal(env, req, u, "page", "", cible);
        let html = await rep.text();
        html = html.replace("</body>", BALISE_ACTIVITE + "</body>");
        return new Response(html, { headers: rep.headers });
      }
      return rep;
    }

    return Response.redirect(url.origin + "/", 302);
  },
};

/* ---------- API ---------- */
async function api(req, env, url, u) {
  const p = url.pathname;
  const corps = req.method === "POST" ? await req.json().catch(() => ({})) : {};

  /* -- session -- */
  if (p === "/api/moi")
    return u ? json({ email: u.email, nom: u.nom, role: u.role, doit_changer_mdp: !!u.doit_changer_mdp })
             : json({ erreur: "non_connecte" }, 401);

  if (p === "/api/login" && req.method === "POST") {
    const email = String(corps.email || "").trim().toLowerCase();
    const mdp = String(corps.motdepasse || "");
    if (!email || !mdp) return json({ erreur: "champs_manquants" }, 400);
    const cpt = await env.DB.prepare("SELECT * FROM utilisateurs WHERE email = ?").bind(email).first();
    if (!cpt || !cpt.actif) { await journal(env, req, null, "connexion_echec", email); return json({ erreur: "identifiants" }, 401); }
    if (cpt.verrou_jusqua > Date.now()) return json({ erreur: "verrouille", minutes: Math.ceil((cpt.verrou_jusqua - Date.now()) / 60000) }, 429);
    const h = await pbkdf2(mdp, cpt.sel);
    if (!egaliteConstante(h, cpt.hash)) {
      const echecs = (cpt.echecs || 0) + 1;
      const verrou = echecs >= 5 ? Date.now() + 15 * 60000 : 0;
      await env.DB.prepare("UPDATE utilisateurs SET echecs = ?, verrou_jusqua = ? WHERE id = ?").bind(echecs, verrou, cpt.id).run();
      await journal(env, req, null, "connexion_echec", email);
      return json({ erreur: "identifiants" }, 401);
    }
    await env.DB.prepare("UPDATE utilisateurs SET echecs = 0, verrou_jusqua = 0 WHERE id = ?").bind(cpt.id).run();
    const token = alea(32);
    await env.DB.prepare("INSERT INTO sessions (token, user_id, expire_le) VALUES (?,?,?)").bind(token, cpt.id, Date.now() + SESSION_MS).run();
    await journal(env, req, { id: cpt.id, email: cpt.email }, "connexion");
    return json({ ok: true, doit_changer_mdp: !!cpt.doit_changer_mdp, role: cpt.role },
                200, { "set-cookie": cookieSession(token, SESSION_MS / 1000) });
  }

  if (p === "/api/logout" && req.method === "POST") {
    const m = (req.headers.get("cookie") || "").match(/(?:^|;\s*)session=([0-9a-f]{64})/);
    if (m) await env.DB.prepare("DELETE FROM sessions WHERE token = ?").bind(m[1]).run();
    if (u) await journal(env, req, u, "deconnexion");
    return json({ ok: true }, 200, { "set-cookie": cookieSession("x", 0) });
  }

  /* -- changement / définition de mot de passe -- */
  if (p === "/api/motdepasse" && req.method === "POST") {
    const nouveau = String(corps.nouveau || "");
    if (nouveau.length < 10) return json({ erreur: "mot_de_passe_trop_court" }, 400);
    let cible = null;
    if (corps.invite) {   // via lien d'invitation
      cible = await env.DB.prepare("SELECT * FROM utilisateurs WHERE invite_token = ? AND invite_expire > ?")
        .bind(String(corps.invite), Date.now()).first();
      if (!cible) return json({ erreur: "invitation_invalide" }, 400);
    } else if (u) {
      cible = await env.DB.prepare("SELECT * FROM utilisateurs WHERE id = ?").bind(u.id).first();
      const ancien = String(corps.ancien || "");
      if (!egaliteConstante(await pbkdf2(ancien, cible.sel), cible.hash)) return json({ erreur: "ancien_incorrect" }, 401);
    } else return json({ erreur: "non_connecte" }, 401);
    const sel = alea(16);
    const h = await pbkdf2(nouveau, sel);
    await env.DB.prepare("UPDATE utilisateurs SET sel = ?, hash = ?, doit_changer_mdp = 0, invite_token = NULL, invite_expire = NULL WHERE id = ?")
      .bind(sel, h, cible.id).run();
    await env.DB.prepare("DELETE FROM sessions WHERE user_id = ?").bind(cible.id).run(); // révoque les anciennes sessions
    const token = alea(32);
    await env.DB.prepare("INSERT INTO sessions (token, user_id, expire_le) VALUES (?,?,?)").bind(token, cible.id, Date.now() + SESSION_MS).run();
    await journal(env, req, { id: cible.id, email: cible.email }, "motdepasse_defini");
    return json({ ok: true }, 200, { "set-cookie": cookieSession(token, SESSION_MS / 1000) });
  }

  /* -- demande d'accès (publique) → e-mail immédiat aux 2 admins -- */
  if (p === "/api/demande-acces" && req.method === "POST") {
    const nom = String(corps.nom || "").trim().slice(0, 120);
    const email = String(corps.email || "").trim().toLowerCase().slice(0, 200);
    const motif = String(corps.motif || "").trim().slice(0, 500);
    if (!nom || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return json({ erreur: "champs_invalides" }, 400);
    const existant = await env.DB.prepare("SELECT id FROM utilisateurs WHERE email = ?").bind(email).first();
    if (existant) return json({ erreur: "deja_utilisateur" }, 400);
    const attente = await env.DB.prepare("SELECT id FROM demandes_acces WHERE email = ? AND statut = 'en_attente'").bind(email).first();
    if (attente) return json({ ok: true, deja: true });
    await env.DB.prepare("INSERT INTO demandes_acces (nom, email, motif) VALUES (?,?,?)").bind(nom, email, motif).run();
    await journal(env, req, null, "demande_acces", email);
    await envoyerEmail(env, ADMINS, "AB2Pro — demande d'accès de " + nom,
      `Nouvelle demande d'accès aux outils AB2Pro :\n\nNom : ${nom}\nE-mail : ${email}\nMotif : ${motif || "(non précisé)"}\n\n` +
      `Approuver ou refuser : ${url.origin}/admin (onglet Demandes).`, { env, req });
    return json({ ok: true });
  }

  /* -- demande de fiche IDCC (utilisateur connecté) → base + e-mail immédiat aux admins -- */
  if (p === "/api/demande-fiche" && req.method === "POST") {
    if (!u) return json({ erreur: "non_connecte" }, 401);
    const idcc = String(corps.idcc || "").trim();
    if (!/^\d{2,4}$/.test(idcc)) return json({ erreur: "idcc_invalide" }, 400);
    const attente = await env.DB.prepare("SELECT id FROM demandes_fiches WHERE idcc = ? AND statut = 'en_attente'").bind(idcc).first();
    if (attente) return json({ ok: true, deja: true });
    await env.DB.prepare("INSERT INTO demandes_fiches (idcc, demandeur_email, demandeur_nom) VALUES (?,?,?)")
      .bind(idcc, u.email, u.nom || "").run();
    await journal(env, req, u, "demande_fiche", idcc);
    await envoyerEmail(env, ADMINS, "AB2Pro — demande de fiche IDCC " + idcc,
      `${u.nom || u.email} (${u.email}) demande l'ajout de la fiche de la convention IDCC ${idcc} dans Veille Conventions.\n\n` +
      `Traitement automatique : sous ~30 minutes, la fiche est constituée sur sources officielles, déployée, et le demandeur est prévenu par e-mail.\n` +
      `Pour la créer immédiatement : demandez-le à Claude.`, { env, req });
    return json({ ok: true });
  }

  /* -- journal d'activité (balise des apps) -- */
  if (p === "/api/activite" && req.method === "POST") {
    if (!u) return json({ erreur: "non_connecte" }, 401);
    await journal(env, req, u, String(corps.type || "action").slice(0, 60), corps.details || "", corps.page || "");
    return json({ ok: true });
  }

  /* -- administration -- */
  if (p.startsWith("/api/admin/")) {
    if (!u) return json({ erreur: "non_connecte" }, 401);
    if (u.role !== "admin") return json({ erreur: "reserve_admin" }, 403);

    if (p === "/api/admin/apercu") {
      const dem = await env.DB.prepare("SELECT * FROM demandes_acces WHERE statut = 'en_attente' ORDER BY id DESC").all();
      const usr = await env.DB.prepare("SELECT id, email, nom, role, actif, doit_changer_mdp, cree_le, cree_par FROM utilisateurs ORDER BY id").all();
      return json({ demandes: dem.results, utilisateurs: usr.results });
    }

    if (p === "/api/admin/test-email") {
      const res = await envoyerEmail(env, ADMINS, "AB2Pro — test e-mail du portail",
        "Test de la messagerie demandé par " + u.email + ". Si vous lisez ceci, l'envoi vers votre adresse fonctionne.",
        { env, req });
      return json({ resultats: res.map(r => ({ destinataire: r.dest, ok: r.ok, status: r.status, reponse: r.corps })) });
    }

    if (p === "/api/admin/logs") {
      const email = url.searchParams.get("email") || "";
      const type = url.searchParams.get("type") || "";
      let q = "SELECT ts, email, type, details, page, ip FROM activites";
      const cond = [], args = [];
      if (email) { cond.push("email LIKE ?"); args.push("%" + email + "%"); }
      if (type) { cond.push("type = ?"); args.push(type); }
      if (cond.length) q += " WHERE " + cond.join(" AND ");
      q += " ORDER BY id DESC LIMIT 500";
      const r = await env.DB.prepare(q).bind(...args).all();
      return json({ logs: r.results });
    }

    if (p === "/api/admin/approuver" && req.method === "POST") {
      const d = await env.DB.prepare("SELECT * FROM demandes_acces WHERE id = ? AND statut = 'en_attente'").bind(corps.id | 0).first();
      if (!d) return json({ erreur: "demande_introuvable" }, 404);
      const invite = alea(24);
      const sel = alea(16), hprov = await pbkdf2(alea(16), sel); // mot de passe provisoire inutilisable : passage obligé par le lien
      await env.DB.prepare(
        "INSERT INTO utilisateurs (email, nom, sel, hash, role, doit_changer_mdp, invite_token, invite_expire, cree_par) VALUES (?,?,?,?,?,1,?,?,?)")
        .bind(d.email, d.nom, sel, hprov, corps.role === "admin" ? "admin" : "user", invite, Date.now() + INVITE_MS, u.email).run();
      await env.DB.prepare("UPDATE demandes_acces SET statut = 'approuvee', traite_par = ?, traite_le = datetime('now') WHERE id = ?").bind(u.email, d.id).run();
      const lien = url.origin + "/motdepasse.html?invite=" + invite;
      await envoyerEmail(env, d.email, "AB2Pro — votre accès est ouvert",
        `Bonjour ${d.nom},\n\nVotre accès aux outils AB2Pro a été approuvé par ${u.email}.\n` +
        `Définissez votre mot de passe (lien valable 72 h) :\n${lien}\n\nPortail : ${url.origin}/app/`, { env, req });
      await journal(env, req, u, "admin_approbation", d.email);
      return json({ ok: true, lien });
    }

    if (p === "/api/admin/refuser" && req.method === "POST") {
      await env.DB.prepare("UPDATE demandes_acces SET statut = 'refusee', traite_par = ?, traite_le = datetime('now') WHERE id = ? AND statut = 'en_attente'")
        .bind(u.email, corps.id | 0).run();
      await journal(env, req, u, "admin_refus", String(corps.id));
      return json({ ok: true });
    }

    if (p === "/api/admin/role" && req.method === "POST") {
      const cible = await env.DB.prepare("SELECT * FROM utilisateurs WHERE id = ?").bind(corps.id | 0).first();
      if (!cible) return json({ erreur: "utilisateur_introuvable" }, 404);
      if (cible.email === u.email) return json({ erreur: "pas_soi_meme" }, 400);
      const role = corps.role === "admin" ? "admin" : "user";
      await env.DB.prepare("UPDATE utilisateurs SET role = ? WHERE id = ?").bind(role, cible.id).run();
      await journal(env, req, u, "admin_role", cible.email + " → " + role);
      return json({ ok: true });
    }

    if (p === "/api/admin/actif" && req.method === "POST") {
      const cible = await env.DB.prepare("SELECT * FROM utilisateurs WHERE id = ?").bind(corps.id | 0).first();
      if (!cible) return json({ erreur: "utilisateur_introuvable" }, 404);
      if (cible.email === u.email) return json({ erreur: "pas_soi_meme" }, 400);
      const actif = corps.actif ? 1 : 0;
      await env.DB.prepare("UPDATE utilisateurs SET actif = ? WHERE id = ?").bind(actif, cible.id).run();
      if (!actif) await env.DB.prepare("DELETE FROM sessions WHERE user_id = ?").bind(cible.id).run();
      await journal(env, req, u, "admin_actif", cible.email + " → " + (actif ? "réactivé" : "désactivé"));
      return json({ ok: true });
    }

    if (p === "/api/admin/reinviter" && req.method === "POST") {
      const cible = await env.DB.prepare("SELECT * FROM utilisateurs WHERE id = ?").bind(corps.id | 0).first();
      if (!cible) return json({ erreur: "utilisateur_introuvable" }, 404);
      const invite = alea(24);
      await env.DB.prepare("UPDATE utilisateurs SET invite_token = ?, invite_expire = ?, doit_changer_mdp = 1 WHERE id = ?")
        .bind(invite, Date.now() + INVITE_MS, cible.id).run();
      const lien = url.origin + "/motdepasse.html?invite=" + invite;
      await envoyerEmail(env, cible.email, "AB2Pro — réinitialisation de votre mot de passe",
        `Bonjour,\n\nDéfinissez un nouveau mot de passe (lien valable 72 h) :\n${lien}`, { env, req });
      await journal(env, req, u, "admin_reinvitation", cible.email);
      return json({ ok: true, lien });
    }
  }

  return json({ erreur: "inconnu" }, 404);
}

/* ---------- balise d'activité injectée dans chaque application servie ---------- */
const BALISE_ACTIVITE = `<script>
(function () {
  window.abLog = function (type, details) {
    try {
      navigator.sendBeacon("/api/activite", new Blob([JSON.stringify({
        type: type, details: String(details || "").slice(0, 400), page: location.pathname
      })], { type: "application/json" }));
    } catch (e) {}
  };
  /* traceurs génériques : impression (= étude de prix / PDF) et clics sur les boutons principaux */
  window.addEventListener("beforeprint", function () { abLog("impression_pdf"); });
  document.addEventListener("click", function (e) {
    var b = e.target && e.target.closest ? e.target.closest("button[id]") : null;
    if (!b) return;
    var ids = { "btn-etude": "etude_prix", "btn-npilote": "solveur_net", "btn-go": "recherche", "btn-dist": "calcul_distance" };
    if (ids[b.id]) abLog(ids[b.id], (document.getElementById("in-q") || {}).value || "");
  }, true);
})();
</script>`;
