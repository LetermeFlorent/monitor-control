# Monitor Control

Une extension GNOME Shell pour régler la luminosité et le contraste de ses écrans externes depuis la barre du haut, sans toucher aux boutons du moniteur.

Elle parle à l'écran par DDC/CI, le canal que la plupart des moniteurs de bureau ouvrent sur le câble HDMI ou DisplayPort, en passant par `ddcutil`. Chaque écran branché a son sous-menu, avec un curseur de luminosité et un de contraste.

## Plus sombre que le minimum

Un moniteur réglé à 0 % de luminosité éclaire encore beaucoup, assez pour fatiguer les yeux le soir dans une pièce sans lumière. L'extension ajoute donc un voile noir, écran par écran, que GNOME dessine par-dessus l'image. Il descend là où le rétroéclairage ne va plus.

Le voile reste en place quand une vidéo ou un jeu passe en plein écran, et il ne gêne ni les clics ni le glisser-déposer des fenêtres. Il tient aussi à travers le verrouillage de session : sans cela, chaque déverrouillage ferait passer l'écran en pleine luminosité pendant un instant. C'est la raison pour laquelle l'extension reste active sur l'écran de verrouillage, où elle ne fait rien d'autre que garder le voile.

Les réglages de chaque écran sont gardés et remis au démarrage de la session. Un écran débranché puis rebranché retrouve les siens, même s'il change de prise, parce que l'extension le reconnaît à son modèle et à son numéro de série.

## Ce qu'il faut avant

Le paquet `ddcutil` doit être installé, et votre compte doit pouvoir lire les bus i2c.

```sh
# Fedora
sudo dnf install ddcutil
# Debian, Ubuntu
sudo apt install ddcutil
```

Sur Fedora, le paquet donne l'accès tout seul. Ailleurs, il faut parfois ajouter son compte au groupe `i2c` puis rouvrir la session. `ddcutil detect` dans un terminal dit si c'est bon : il doit lister vos écrans.

L'option DDC/CI doit aussi être active dans le menu du moniteur. Beaucoup la laissent allumée d'usine, certains non.

## Installation

Depuis [extensions.gnome.org](https://extensions.gnome.org/), ou à la main :

```sh
git clone https://github.com/LetermeFlorent/monitor-control.git \
  ~/.local/share/gnome-shell/extensions/monitor-control@letermeflorent.github.io
gnome-extensions enable monitor-control@letermeflorent.github.io
```

Sous Wayland, GNOME ne charge une nouvelle extension qu'après une déconnexion.

## Si un écran n'apparaît pas

Un écran en veille ne répond pas en DDC/CI. Réveillez-le puis cliquez sur « Refresh displays » dans le menu. Les écrans intégrés des portables n'ont pas de DDC/CI, leur luminosité reste gérée par GNOME.

Compatible GNOME Shell 48 à 50. Licence GPL-2.0-or-later.
