Good — here's the full list as it stands, reordered per tonight's adjustments:

** Embuscade TODO list**

1. ~~Text chat (all screens except Join Bolo)~~
2. ~~Respawn placement (≥6.25 cells from other players — Bob Euler's constant)~~
3. ~~Equidistant starting positions at game start~~
5. ~~AI players~~
7. ~~Sound effects~~
6. Power-ups
4. ~~Voice chat~~ — done: open-mic toggle (Right Ctrl, not push-to-talk), mesh WebRTC signaled over the existing WebSocket, available in Lobby/Game/EndGame/Builder-edit, muted state persists in localStorage across games. No TURN server, so voice may fail to connect across strict/symmetric NATs.
5. ~~Show scores in end game dialog right rail, make chat area larger. remove ai players from who~~ — done.
8. Keybinding customization
9. High-DPI canvas fix (`devicePixelRatio` scaling — currently blurry on retina/high-res displays)
10. Sprite scale-up — reconsider `SPRITE_SIZE` and/or grid resolution (32×32 → 64×64) now that cells are 256px; look at it rendered first before deciding
11. ~~README~~
12. Custom pixel-editor UI (the "Custom (soon)" stub in the tank picker)
13. github actions builds for the client, server, and docker image.
14. themes for games, jungle, desert, arctic, etc.
15. ~~proper splash screen~~
16. proper sprites for powerups

powerups:

## Powerup spec (v1)

**Damage-absorption trio** — precedence when multiple are active: **invincible shield first (blocks everything, no cap), then wall grease for wall damage specifically, then shield for everything else.** A hit is absorbed by exactly one layer, whichever applies first in that order; only spills through to health once all applicable layers are exhausted.

1. **Wall grease** — absorbs wall damage only, 150-point capacity. Brown arc around the tank's rear; arc thickness/length shows remaining capacity.
2. **Shield** — absorbs any damage (wall, shot, ram) not already caught by wall grease, 150-point capacity. Radial gradient ring, 5px, thickness shows remaining capacity.
3. **Invincible shield** — blocks all damage entirely, no capacity limit, lasts 5s. Solid green ring.

**Rams horns** — while active, tank-vs-tank collision damage is dealt at **1.5× normal ramming damage**, and that damage is absorbed by the horns (150-point capacity) before touching the wearer's health — effectively a ramming-specific shield that also amplifies outgoing damage. Two horn icons shown at the tank's front.

**Weapon pair, stacking rule:**
- **Missile alone**: replaces your normal shot entirely — firing any of the four directions launches a missile (50 damage) instead of a standard shot.
- **Double barrel alone**: each fire input launches two standard shots instead of one.
- **Both active together**: each fire input launches two missiles.
- Both last 8s.

5. **Missile** — 50 damage, replaces normal shot when active alone. 8s duration.
6. **Double barrel** — fires two projectiles per input instead of one (shots or missiles, per the stacking rule above). 8s duration.

**Health pair:**
7. **Health** — +50 health, capped at current max (100, or 200 if health-boosted).
8. **Health boost** — raises max health by 100 (up to a 200 ceiling).

9. **Hearth stone** — single use. Teleports the holder back to their original spawn point the instant it's triggered, then is consumed (removed from active effects, doesn't persist for reuse).

10. **Speed boost** — instantly doubles current speed at the moment of pickup, and doubles `MAX_SPEED` for the duration (so the player can also accelerate further than normal while it's active). 5s duration.

**Hazard pair (world objects, not tank buffs):**
11. **Oil gun** — three charges. Each use drops an oil slick hazard on the map (presumably at the tank's current position, or just behind it — worth confirming placement once we design this pass). Three oil-can icons shown at the tank's front, depleting per use.
12. **Oil slick** — placed hazard object, 4s lifetime before despawning. Any tank driving over it loses steering/throttle control: can't turn, accelerate, or decelerate, and coasts at whatever speed it had at the moment of contact for 1.5s.

audio files key.  NOTE - these are all from freesound.org.  NOTE ALSO - I have
no aptitude for audio engineering.
`151713__bowlingballout__pvc-rocket-cannon.wav`                        - missle
`420673__sypherzent__basic-melee-hit.wav`                              - when tank is shot
`812592__qubodup__clang.wav`                                           - when tanks collide
`515801__lilmati__retro-pirate-cannon-shot.wav`                        - double barrel
`528262__magnuswaker__silenced-shot.wav`                               - basic shot
`609587__unfa__grenade-explosion-sfx-medium-sized-meaty-realistic.flac`- tank explodes
`743259__qubodup__short-rusty-metal-scrape.flac`                       - wall collision
`802577__qubodup__creaking-floorboards-05.wav`                         - slip on oil
`589836__mrfossy__sfx_squelch_slayer_215.wav`                          - spray oil
`67617__qubodup__metal-crash-collision.flac`                           - battering ram
`406622__xemptful__ready-trimmed.wav`                                  - ready fight!

