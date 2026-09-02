/* ===== AB2Pro — Worker d'authentification, rôles et journal d'activité =====
 * Protège les 4 applications (simulateur, Veille Paie, Veille Conventions, Salaires Europe & Maghreb) + portail,
 * avec accès PAR SECTION choisi par les admins (utilisateurs.sections, NULL = tout).
 * D1 : utilisateurs, sessions, demandes_acces, activites (voir schema.sql).
 * E-mails immédiats aux admins via Resend (secret RESEND_API_KEY).
 * Les fichiers statiques (assets/) ne sont servis qu'après session valide. */

const ADMINS = ["wboussard@gmail.com", "urgens.martinez@ab2pro.com"];
/* Hiérarchie : super_admin (les 2 fondateurs, intouchables) > admin > user.
 * admin : gère les utilisateurs simples et les demandes d'accès (rôle user).
 * super_admin seul : promouvoir/rétrograder un admin, désactiver un admin, approuver en admin,
 * réinviter un admin/super_admin. Un super_admin ne peut JAMAIS être rétrogradé ni désactivé. */
const estAdmin = x => !!x && (x.role === "admin" || x.role === "super_admin");
const estSuper = x => !!x && x.role === "super_admin";

/* Accès par section : l'admin choisit les applications visibles par chaque utilisateur.
 * utilisateurs.sections = NULL → accès à tout (héritage) ; sinon tableau JSON de slugs.
 * Les admins et super admins voient toujours tout. */
const SECTIONS_APPS = ["simulateur", "paie", "conventions", "salaires-europe", "logements"];

/* Adresse de réponse des communications EXTERNES d'AB Service (réservations
 * DATAtourisme, etc.) — domaine dédié actif depuis le 03/09/2026 (Email Routing
 * + catch-all vers ab2pro-mail-fanout configurés par la direction). */
const EMAIL_EXTERNE = "info@abservice-logement.com";

/* ===== Entités & agences (décision direction 02/09/2026) =====
 * AB2Pro et AB Service sont deux entités séparées : chaque utilisateur choisit son
 * entité à l'inscription ; côté AB Service il se rattache à une ou plusieurs agences
 * (modifiables ensuite via son profil). Les réponses des logeurs sont routées vers
 * son e-mail perso + les boîtes génériques de ses agences (worker mail-fanout). */
const ENTITES = ["ab2pro", "abservice"];
const AGENCES_ABSERVICE = {
  "rennes": "rennes@abservicefrance.com",
  "paris": "paris@abservicefrance.com",
  "bordeaux": "bordeaux@abservicefrance.com",
  "aix-en-provence": "aix-en-provence@abservicefrance.com",
  "lyon": "lyon@abservicefrance.com",
  "strasbourg": "strasbourg@abservicefrance.com",
  "angers": "angers@abservicefrance.com",
  "rouen": "rouen@abservicefrance.com",
  "nantes": "nantes@abservicefrance.com",
  "toulouse": "toulouse@abservicefrance.com",
  "lille": "lille@abservicefrance.com",
};
const entiteDe = x => (x && x.entite === "abservice") ? "abservice" : "ab2pro";
function agencesDe(x) {
  if (!x || !x.agences) return [];
  try { const l = JSON.parse(x.agences); return Array.isArray(l) ? l.filter(a => AGENCES_ABSERVICE[a]) : []; }
  catch (e) { return []; }
}
const validerAgences = l => Array.isArray(l) ? JSON.stringify(l.map(String).filter(a => AGENCES_ABSERVICE[a]).slice(0, 11)) : null;
/* Adresse de réponse par utilisateur (sous-adressage info+u<id>@ → le worker
 * mail-fanout relaie la réponse du logeur à l'e-mail perso du demandeur + aux
 * boîtes génériques de ses agences). ACTIF depuis le 03/09/2026 : la règle
 * CATCH-ALL d'abservice-logement.com pointe sur ab2pro-mail-fanout. */
const SOUS_ADRESSAGE_REPONSES = true;
function adresseReponse(u2) {
  if (!SOUS_ADRESSAGE_REPONSES || !u2 || !u2.id) return EMAIL_EXTERNE;
  const [loc, dom] = EMAIL_EXTERNE.split("@");
  return loc + "+u" + u2.id + "@" + dom;
}
function sectionsDe(x) {
  if (!x) return [];
  if (estAdmin(x)) return SECTIONS_APPS;
  if (x.sections == null || x.sections === "") return SECTIONS_APPS;
  try {
    const l = JSON.parse(x.sections);
    return Array.isArray(l) ? l.filter(s => SECTIONS_APPS.includes(s)) : SECTIONS_APPS;
  } catch (e) { return SECTIONS_APPS; }
}
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
      .bind(u ? u.id : null, u ? u.email : "", type,
            String(details).slice(0, type === "etude_prix" ? 8000 : 500), String(page).slice(0, 200),
            req.headers.get("cf-connecting-ip") || "").run();
  } catch (e) { /* le journal ne doit jamais casser une requête */ }
}

async function utilisateurDeSession(env, req) {
  const m = (req.headers.get("cookie") || "").match(/(?:^|;\s*)session=([0-9a-f]{64})/);
  if (!m) return null;
  const r = await env.DB.prepare(
    "SELECT u.id, u.email, u.nom, u.role, u.actif, u.doit_changer_mdp, u.sections, s.token, s.expire_le " +
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
    /* adresse canonique : www → racine (les cookies de session ne se partagent pas entre les deux hôtes) */
    if (url.hostname.startsWith("www.")) {
      url.hostname = url.hostname.slice(4);
      return Response.redirect(url.toString(), 301);
    }
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
      if (!estAdmin(u)) return new Response("Accès réservé aux administrateurs.", { status: 403 });
      return env.ASSETS.fetch(new Request(url.origin + "/admin.html", req));
    }

    /* --- applications protégées --- */
    if (p === "/app" || p.startsWith("/app/")) {
      if (!u) return Response.redirect(url.origin + "/?suite=" + encodeURIComponent(p), 302);
      if (u.doit_changer_mdp) return Response.redirect(url.origin + "/motdepasse.html", 302);
      const cible = (p === "/app" || p === "/app/") ? "/app/index.html" : p;
      const mSec = cible.match(/^\/app\/([a-z][a-z-]*)\.html$/);
      if (mSec && SECTIONS_APPS.includes(mSec[1]) && !sectionsDe(u).includes(mSec[1])) {
        await journal(env, req, u, "acces_refuse_section", mSec[1], cible);
        return new Response(PAGE_SECTION_REFUSEE, { status: 403, headers: { "content-type": "text/html; charset=utf-8" } });
      }
      /* données personnelles bailleurs : réservées aux utilisateurs de la section logements */
      if (cible === "/app/data/bailleurs.json" && !sectionsDe(u).includes("logements")) {
        await journal(env, req, u, "acces_refuse_section", "logements", cible);
        return new Response("{}", { status: 403, headers: { "content-type": "application/json" } });
      }
      const rep = await env.ASSETS.fetch(new Request(url.origin + cible, req));
      const ct = rep.headers.get("content-type") || "";
      if (rep.ok && ct.includes("text/html")) {
        await journal(env, req, u, "page", "", cible);
        let html = await rep.text();
        html = html.replace("</head>", "<script>window.AB_SECTIONS=" + JSON.stringify(sectionsDe(u)) + ";</script></head>");
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

  /* ===== DATAtourisme LIVE (proxy — la clé API reste un SECRET serveur : la page
     n'appelle jamais api.datatourisme.fr en direct, sinon la clé fuirait côté client).
     Secret : wrangler secret put DATATOURISME_API_KEY (dossier src/auth). ===== */
  if (p === "/api/dt/ping")
    return json({ configuree: !!env.DATATOURISME_API_KEY });
  if (p === "/api/dt/catalog") {
    if (!u) return json({ erreur: "non_connecte" }, 401);
    if (!sectionsDe(u).includes("logements")) return json({ erreur: "section" }, 403);
    if (!env.DATATOURISME_API_KEY) return json({ configuree: false }, 503);
    const cible = new URL("https://api.datatourisme.fr/v1/catalog");
    for (const k of ["geo_distance", "type", "fields", "page", "page_size", "search", "sort"]) {
      const v = url.searchParams.get(k);
      if (v) cible.searchParams.set(k, v);
    }
    const rep = await fetch(cible, { headers: { "X-API-Key": env.DATATOURISME_API_KEY } });
    return new Response(rep.body, { status: rep.status, headers: { "content-type": "application/json; charset=utf-8" } });
  }
  if (p.startsWith("/api/dt/contact/") && req.method === "POST") {
    /* demande de RÉSERVATION à l'hôte via l'endpoint officiel (target booking) —
       un clic = un envoi, réponse sur logements@ ; journalisé (pas d'envoi en masse) */
    if (!u) return json({ erreur: "non_connecte" }, 401);
    if (!sectionsDe(u).includes("logements")) return json({ erreur: "section" }, 403);
    if (!env.DATATOURISME_API_KEY) return json({ configuree: false }, 503);
    const uuid = p.slice("/api/dt/contact/".length);
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(uuid))
      return json({ erreur: "uuid" }, 400);
    const message = String(corps.message || "").slice(0, 5000);
    if (message.length < 20) return json({ erreur: "message_trop_court" }, 400);
    /* AB Service est une entité à part : AUCUNE mention du groupe parent dans les
       communications externes (décision direction 02/09). L'adresse de réponse
       basculera sur info@abservice-logement.com dès que le domaine sera actif. */
    const charge = {
      name: (u.nom || "AB Service").slice(0, 255),
      email: adresseReponse(u),
      message,
      subject: String(corps.subject || "Demande de location — équipes en mission (AB Service)").slice(0, 255),
      target: "booking",
    };
    const rep = await fetch("https://api.datatourisme.fr/v1/catalog/" + uuid + "/contact", {
      method: "POST",
      headers: { "X-API-Key": env.DATATOURISME_API_KEY, "content-type": "application/json" },
      body: JSON.stringify(charge),
    });
    await journal(env, req, u, "dt_contact", uuid, "statut " + rep.status);
    if (rep.status === 422) return json({ erreur: "pas_email_reservation" }, 422);
    return json({ ok: rep.ok, statut: rep.status }, rep.ok ? 200 : rep.status);
  }

  /* -- session -- */
  if (p === "/api/moi")
    return u ? json({ email: u.email, nom: u.nom, role: u.role, doit_changer_mdp: !!u.doit_changer_mdp, sections: sectionsDe(u),
                      entite: entiteDe(u), agences: agencesDe(u), agences_disponibles: Object.keys(AGENCES_ABSERVICE),
                      adresse_reponse: adresseReponse(u) })
             : json({ erreur: "non_connecte" }, 401);

  /* -- profil : l'utilisateur AB Service change lui-même ses agences de rattachement -- */
  if (p === "/api/profil" && req.method === "POST") {
    if (!u) return json({ erreur: "non_connecte" }, 401);
    if (entiteDe(u) !== "abservice") return json({ erreur: "reserve_abservice" }, 403);
    const ag = validerAgences(corps.agences);
    if (ag === null || JSON.parse(ag).length === 0) return json({ erreur: "agences_invalides" }, 400);
    await env.DB.prepare("UPDATE utilisateurs SET agences = ? WHERE id = ?").bind(ag, u.id).run();
    await journal(env, req, u, "profil_agences", ag);
    return json({ ok: true, agences: JSON.parse(ag) });
  }

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
    /* entité obligatoire ; agences obligatoires (≥1) si AB Service */
    const entite = ENTITES.includes(corps.entite) ? corps.entite : null;
    const agences = entite === "abservice" ? validerAgences(corps.agences) : null;
    if (!nom || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return json({ erreur: "champs_invalides" }, 400);
    if (!entite) return json({ erreur: "entite_requise" }, 400);
    if (entite === "abservice" && (!agences || JSON.parse(agences).length === 0)) return json({ erreur: "agence_requise" }, 400);
    const existant = await env.DB.prepare("SELECT id FROM utilisateurs WHERE email = ?").bind(email).first();
    if (existant) return json({ erreur: "deja_utilisateur" }, 400);
    const attente = await env.DB.prepare("SELECT id FROM demandes_acces WHERE email = ? AND statut = 'en_attente'").bind(email).first();
    if (attente) return json({ ok: true, deja: true });
    await env.DB.prepare("INSERT INTO demandes_acces (nom, email, motif, entite, agences) VALUES (?,?,?,?,?)")
      .bind(nom, email, motif, entite, agences).run();
    await journal(env, req, null, "demande_acces", email + " (" + entite + (agences ? " " + agences : "") + ")");
    await envoyerEmail(env, ADMINS, (entite === "abservice" ? "AB Service" : "AB2Pro") + " — demande d'accès de " + nom,
      `Nouvelle demande d'accès au portail :\n\nNom : ${nom}\nE-mail : ${email}\n` +
      `Entité : ${entite === "abservice" ? "AB SERVICE" : "AB2PRO"}\n` +
      (agences ? `Agences de rattachement : ${JSON.parse(agences).join(", ")}\n` : "") +
      `Motif : ${motif || "(non précisé)"}\n\n` +
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

  /* -- point d'envoi des routines (clé secrète NOTIFY_KEY) : expéditeur du domaine, destinataires =
   *    tous les admins ACTIFS de la base (dynamique), ou une liste explicite via "dest" -- */
  if (p === "/api/notifier" && req.method === "POST") {
    const cle = req.headers.get("x-notify-key") || "";
    if (!env.NOTIFY_KEY || !egaliteConstante(cle, env.NOTIFY_KEY)) return json({ erreur: "cle_invalide" }, 403);
    const sujet = String(corps.sujet || "").slice(0, 200);
    const texte = String(corps.texte || "").slice(0, 20000);
    if (!sujet || !texte) return json({ erreur: "champs_manquants" }, 400);
    let dests = Array.isArray(corps.dest) && corps.dest.length
      ? corps.dest.map(d => String(d).trim().toLowerCase()).filter(d => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(d)).slice(0, 20)
      : (await env.DB.prepare("SELECT email FROM utilisateurs WHERE role IN ('admin','super_admin') AND actif = 1").all()).results.map(r => r.email);
    const res = await envoyerEmail(env, dests, sujet, texte, { env, req });
    await journal(env, req, null, "notifier", sujet.slice(0, 120) + " → " + dests.join(","));
    return json({ resultats: res.map(r => ({ destinataire: r.dest, ok: r.ok, status: r.status })) });
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
    if (!estAdmin(u)) return json({ erreur: "reserve_admin" }, 403);

    if (p === "/api/admin/apercu") {
      const dem = await env.DB.prepare("SELECT * FROM demandes_acces WHERE statut = 'en_attente' ORDER BY id DESC").all();
      const usr = await env.DB.prepare("SELECT id, email, nom, role, actif, doit_changer_mdp, cree_le, cree_par, sections, entite, agences FROM utilisateurs ORDER BY id").all();
      return json({ demandes: dem.results, utilisateurs: usr.results, sections_apps: SECTIONS_APPS, agences_abservice: Object.keys(AGENCES_ABSERVICE) });
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
      if (corps.role === "admin" && !estSuper(u)) return json({ erreur: "reserve_super_admin" }, 403);
      const d = await env.DB.prepare("SELECT * FROM demandes_acces WHERE id = ? AND statut = 'en_attente'").bind(corps.id | 0).first();
      if (!d) return json({ erreur: "demande_introuvable" }, 404);
      const invite = alea(24);
      const sel = alea(16), hprov = await pbkdf2(alea(16), sel); // mot de passe provisoire inutilisable : passage obligé par le lien
      /* sections choisies par l'admin à l'approbation (rôle user seulement ; absence = accès à tout) */
      const secsApprob = (corps.role !== "admin" && Array.isArray(corps.sections))
        ? JSON.stringify(corps.sections.map(String).filter(s => SECTIONS_APPS.includes(s))) : null;
      /* l'entité et les agences choisies à l'inscription suivent la demande */
      await env.DB.prepare(
        "INSERT INTO utilisateurs (email, nom, sel, hash, role, doit_changer_mdp, invite_token, invite_expire, cree_par, sections, entite, agences) VALUES (?,?,?,?,?,1,?,?,?,?,?,?)")
        .bind(d.email, d.nom, sel, hprov, corps.role === "admin" ? "admin" : "user", invite, Date.now() + INVITE_MS, u.email, secsApprob,
              d.entite || null, d.agences || null).run();
      await env.DB.prepare("UPDATE demandes_acces SET statut = 'approuvee', traite_par = ?, traite_le = datetime('now') WHERE id = ?").bind(u.email, d.id).run();
      const lien = url.origin + "/motdepasse.html?invite=" + invite;
      const marque = d.entite === "abservice" ? "AB Service" : "AB2Pro";
      await envoyerEmail(env, d.email, marque + " — votre accès est ouvert",
        `Bonjour ${d.nom},\n\nVotre accès au portail ${marque} a été approuvé par ${u.email}.\n` +
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
      if (!estSuper(u)) return json({ erreur: "reserve_super_admin" }, 403);   // seuls les super admins promeuvent/rétrogradent
      const cible = await env.DB.prepare("SELECT * FROM utilisateurs WHERE id = ?").bind(corps.id | 0).first();
      if (!cible) return json({ erreur: "utilisateur_introuvable" }, 404);
      if (cible.role === "super_admin") return json({ erreur: "intouchable" }, 403);  // un super admin ne se rétrograde JAMAIS
      if (cible.email === u.email) return json({ erreur: "pas_soi_meme" }, 400);
      const role = corps.role === "admin" ? "admin" : "user";
      await env.DB.prepare("UPDATE utilisateurs SET role = ? WHERE id = ?").bind(role, cible.id).run();
      await journal(env, req, u, "admin_role", cible.email + " → " + role);
      return json({ ok: true });
    }

    if (p === "/api/admin/actif" && req.method === "POST") {
      const cible = await env.DB.prepare("SELECT * FROM utilisateurs WHERE id = ?").bind(corps.id | 0).first();
      if (!cible) return json({ erreur: "utilisateur_introuvable" }, 404);
      if (cible.role === "super_admin") return json({ erreur: "intouchable" }, 403); // un super admin ne se désactive JAMAIS
      if (cible.role === "admin" && !estSuper(u)) return json({ erreur: "reserve_super_admin" }, 403);
      if (cible.email === u.email) return json({ erreur: "pas_soi_meme" }, 400);
      const actif = corps.actif ? 1 : 0;
      await env.DB.prepare("UPDATE utilisateurs SET actif = ? WHERE id = ?").bind(actif, cible.id).run();
      if (!actif) await env.DB.prepare("DELETE FROM sessions WHERE user_id = ?").bind(cible.id).run();
      await journal(env, req, u, "admin_actif", cible.email + " → " + (actif ? "réactivé" : "désactivé"));
      return json({ ok: true });
    }

    if (p === "/api/admin/sections" && req.method === "POST") {
      const cible = await env.DB.prepare("SELECT * FROM utilisateurs WHERE id = ?").bind(corps.id | 0).first();
      if (!cible) return json({ erreur: "utilisateur_introuvable" }, 404);
      if (cible.role !== "user") return json({ erreur: "admins_acces_total" }, 400); // un admin voit toujours tout
      const secs = Array.isArray(corps.sections) ? corps.sections.map(String).filter(s => SECTIONS_APPS.includes(s)) : null;
      if (secs === null) return json({ erreur: "sections_invalides" }, 400);
      await env.DB.prepare("UPDATE utilisateurs SET sections = ? WHERE id = ?").bind(JSON.stringify(secs), cible.id).run();
      await journal(env, req, u, "admin_sections", cible.email + " → " + (secs.length ? secs.join(",") : "(aucune)"));
      return json({ ok: true, sections: secs });
    }

    if (p === "/api/admin/reinviter" && req.method === "POST") {
      const cible = await env.DB.prepare("SELECT * FROM utilisateurs WHERE id = ?").bind(corps.id | 0).first();
      if (!cible) return json({ erreur: "utilisateur_introuvable" }, 404);
      if ((cible.role === "admin" || cible.role === "super_admin") && !estSuper(u))
        return json({ erreur: "reserve_super_admin" }, 403); // réinitialiser l'accès d'un admin = pouvoir sensible
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

/* ---------- page renvoyée quand la section n'est pas autorisée pour l'utilisateur ---------- */
const PAGE_SECTION_REFUSEE = `<!doctype html><html lang="fr"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>AB2Pro — Accès non autorisé</title>
<style>body{margin:0;font:15px/1.6 "Segoe UI",system-ui,sans-serif;background:#f4f4f5;color:#29293b;
display:flex;align-items:center;justify-content:center;min-height:100vh}
.c{background:#fff;border:1px solid #d9d9e0;border-radius:12px;box-shadow:0 4px 14px rgba(60,50,20,.07);
padding:30px 34px;max-width:460px;text-align:center}
h1{font:22px Cambria,Georgia,serif;margin:0 0 8px}b{color:#db303f}
a{display:inline-block;margin-top:16px;background:#db303f;color:#fff;text-decoration:none;
padding:9px 20px;border-radius:18px;font-weight:600}p{color:#5f5f74;margin:6px 0}</style></head><body>
<div class="c"><h1><b>Accès</b> non autorisé</h1>
<p>Votre compte n'a pas accès à cette section du portail AB2Pro.</p>
<p>Si vous en avez besoin, demandez à un administrateur de vous l'ouvrir.</p>
<a href="/app/">⌂ Retour au portail</a></div></body></html>`;

/* ---------- balise d'activité injectée dans chaque application servie ---------- */
const BALISE_ACTIVITE = `<script>
(function () {
  window.abLog = function (type, details) {
    try {
      navigator.sendBeacon("/api/activite", new Blob([JSON.stringify({
        type: type, details: String(details || "").slice(0, 8000), page: location.pathname
      })], { type: "application/json" }));
    } catch (e) {}
  };
  /* traceurs génériques : impression (= étude de prix / PDF) et clics sur les boutons principaux */
  window.addEventListener("beforeprint", function () { abLog("impression_pdf"); });
  document.addEventListener("click", function (e) {
    var b = e.target && e.target.closest ? e.target.closest("button[id]") : null;
    if (!b) return;
    /* btn-etude retiré : le simulateur envoie lui-même un etude_prix ENRICHI (résumé + lien de restauration) */
    var ids = { "btn-npilote": "solveur_net", "btn-go": "recherche", "btn-dist": "calcul_distance" };
    if (ids[b.id]) abLog(ids[b.id], (document.getElementById("in-q") || {}).value || "");
  }, true);

  /* barre de navigation du portail : retour accueil, admin (si admin), déconnexion */
  (async function () {
    try {
      var r = await fetch("/api/moi", { cache: "no-store" });
      if (!r.ok) return;
      var moi = await r.json();
      var barre = document.createElement("div");
      barre.style.cssText = "position:fixed;bottom:14px;right:12px;z-index:2147483000;display:flex;gap:6px;" +
        "font:12.5px 'Segoe UI',system-ui,sans-serif;print-color-adjust:exact";
      barre.className = "barre-portail";
      var st = document.createElement("style");
      st.textContent = "@media print { .barre-portail { display:none !important; } }";
      document.head.appendChild(st);
      function btn(txt, href, fond) {
        var a = document.createElement("a");
        a.textContent = txt; a.href = href;
        a.style.cssText = "background:" + fond + ";color:#fff;padding:7px 13px;border-radius:17px;" +
          "text-decoration:none;font-weight:600;box-shadow:0 2px 10px rgba(0,0,0,.3);white-space:nowrap";
        return a;
      }
      var p = location.pathname;
      var estPortail = (p === "/app" || p === "/app/" || p === "/app/index.html");
      if (!estPortail) barre.appendChild(btn("⌂ Portail", "/app/", "#db303f"));
      if (moi.role === "admin" || moi.role === "super_admin") barre.appendChild(btn("🛡 Admin", "/admin", "#29293b"));
      var dec = btn("Quitter", "#", "#5f5f74");
      dec.addEventListener("click", async function (e) {
        e.preventDefault();
        try { await fetch("/api/logout", { method: "POST" }); } catch (err) {}
        location.href = "/";
      });
      barre.appendChild(dec);
      document.body.appendChild(barre);
    } catch (e) {}
  })();
})();
</script>`;
