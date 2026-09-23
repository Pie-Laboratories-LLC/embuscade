Good — here's the full list as it stands, reordered per tonight's adjustments:

**Lobo TODO list**

1. Text chat (all screens except Join Bolo)
2. Respawn placement (≥6.25 cells from other players — Bob Euler's constant)
3. Equidistant starting positions at game start
5. AI players
4. Voice chat — push-to-talk (left-shift default), mesh WebRTC, signaled over the existing WebSocket
6. Power-ups
7. Sound effects
8. Keybinding customization
9. High-DPI canvas fix (`devicePixelRatio` scaling — currently blurry on retina/high-res displays)
10. Sprite scale-up — reconsider `SPRITE_SIZE` and/or grid resolution (32×32 → 64×64) now that cells are 256px; look at it rendered first before deciding
11. README
12. Custom pixel-editor UI (the "Custom (soon)" stub in the tank picker)
13. Possible rename away from "Lobo"/"Bolo" lineage, if this ever moves toward something more public/commercial

Save that, and tomorrow's a clean slate. Good stopping point for tonight — quite a run today.

powerups:

* wall grease.  A shield for walls
* shield.  A general purpose shield
* invincible shield 5s
* rams horns.  allow ramming where damage is absorbed by the rams horns.  decreases as you ram things
* double barrel.  fires two shots.  stackable with missles
* missles.  fires a missle 50 damage.  stackable with double barrel
* health.  +50 health (to current max health)
* health boost. (raises max health by 100 up to 200 total)
* hearth stone.  allows you to teleport back to where you spawn
* speed boost.  double speed 5s
