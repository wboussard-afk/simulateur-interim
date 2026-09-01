/* Email Worker « fanout » — transfert des e-mails entrants du domaine vers TOUS les
 * super-admins (une règle Email Routing classique n'accepte qu'UNE destination ;
 * la doc officielle prévoit ce worker comme voie multi-destinataires :
 * message.forward() appelé plusieurs fois vers des adresses VÉRIFIÉES).
 *
 * IMPORTANT : chaque adresse ci-dessous doit être ajoutée ET vérifiée dans
 * Email Routing > Destination Addresses avant d'être servie (sinon forward rejette).
 * Liste gérée par la direction — la modifier ici puis `wrangler deploy`. */
const DESTINATAIRES = [
  "wboussard@gmail.com",
  "urgens.martinez@ab2pro.com",
];

export default {
  async email(message, env, ctx) {
    const resultats = await Promise.allSettled(
      DESTINATAIRES.map(adresse => message.forward(adresse))
    );
    // si TOUT échoue (adresses non vérifiées ?), rejeter proprement pour que
    // l'expéditeur reçoive un bounce plutôt qu'un silence
    if (resultats.every(r => r.status === "rejected")) {
      message.setReject("Transfert indisponible — réessayer plus tard.");
    }
  },
};
