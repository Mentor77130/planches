/* Planches — accès direct à Google Drive.
 * Identifiants publics de l'application « Planches » dans Google Cloud (ils ne donnent accès à rien
 * sans l'accord de chaque visiteur). Laissés vides, le bouton Google Drive passe par le sélecteur
 * de fichiers de l'appareil. */
window.PLANCHES_GOOGLE = {
  clientId: '', // ID client OAuth, type « Application Web »
  appId: '',    // numéro du projet Google Cloud
  apiKey: '',   // clé API du sélecteur Google Picker (si Google l'exige)
};
