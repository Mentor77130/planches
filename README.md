# Planches

Lecteur de BD en ligne : les fichiers CBZ, CBR, CBT et PDF se lisent d'un seul défilement vertical, en plein écran, sur ordinateur, iPhone, iPad et Android.

**https://mentor77130.github.io/planches/**

## Ce que fait le site

- Lecture verticale continue : on fait défiler, sans tourner les pages.
- Zoom à la molette (Ctrl), au pincement ou d'un double toucher ; flèches ← et → pour passer d'une page à l'autre.
- Reprise de lecture : les BD déjà ouvertes s'affichent sur l'accueil et se rouvrent d'un clic, à la page où on s'était arrêté.
- Google Drive : connexion au compte Google, puis choix de la BD dans la liste des fichiers du Drive (sélecteur de Google). La BD est téléchargée par morceaux et gardée sur l'appareil.
- Fonctionne hors ligne et s'installe comme une application (écran d'accueil de l'iPhone, bouton « Installer » de Chrome et d'Edge).

## Confidentialité

Les fichiers ne quittent jamais l'appareil : tout est décodé dans le navigateur, y compris les archives RAR. Avec Google Drive, le site n'a accès qu'aux fichiers que vous choisissez vous-même dans le sélecteur de Google (autorisation « drive.file »). Pour permettre la reprise en un clic, une copie des BD ouvertes est gardée dans le stockage du navigateur (IndexedDB), sur l'appareil uniquement. Aucun compte, aucun cookie, aucune statistique de visite.

## Formats

- CBZ / ZIP (y compris ZIP64), CBT / TAR
- CBR / RAR : versions 3, 4 et 5, archives solides comprises
- PDF (avec pdf.js), et des images seules : JPEG, PNG, WebP, GIF, AVIF

## Logiciels tiers

- [pdf.js](https://github.com/mozilla/pdf.js), Mozilla, licence Apache 2.0 (`LICENSE.txt`)
- [pako](https://github.com/nodeca/pako), licence MIT (`pako-LICENSE.txt`)
