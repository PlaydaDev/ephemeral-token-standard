# FINDINGS.md — Éphémère Protocol

Journal des observations faites en faisant compiler et tester le contrat
spec-grade. **Aucune n'a été corrigée dans `lib.rs`** : conformément à
CLAUDE.md (« si un choix te semble faux, EXPLIQUE et propose — ne patch pas
silencieusement ») et à MISSIONS.md (« documenter le problème dans
FINDINGS.md et demander »), chaque entrée décrit le problème, le prouve par
un test, propose un correctif minimal, et attend une décision.

Statut au moment de l'écriture : `anchor build` vert, **34 tests verts**
(lifecycle 11 + adversarial 16 + curve_fuzz 7). Les tests des sections F1/F2/F3
**épinglent le comportement ACTUEL** (ils asserent le panic / le profit-dust).
Si on décide de corriger, ces trois tests devront basculer pour asserter le
succès — c'est volontaire : ils servent de garde anti-régression dans les deux
sens.

> **MISE À JOUR (2026-06-11, validée par le fondateur)** : F1 et F2 sont
> **corrigés** (casts u128, un commentaire d'invariant chacun — les deux seules
> modifications de logique de `lib.rs` depuis le handoff, toutes deux sans
> effet dans la plage de fonctionnement normale). Les tests F1/F2 ont basculé :
> ils poussent désormais les deux multiplications AU-DELÀ des anciennes
> falaises u64 et asserent le résultat exact. F3 est traité comme contrainte
> de calibration : check `check_f3` ajouté à `tools/calibrate.py` (dont le
> défaut `VTOK0` violait justement la contrainte — corrigé à 1e15 unités
> brutes, sans effet sur les multiples simulés). O2 (`overflow-checks = true`)
> est ratifié. Les sections ci-dessous sont conservées telles quelles comme
> journal d'investigation.

---

## Findings curve (Mission 4)

Mission 4 demande explicitement de « vérifier u128 partout dans les
multiplications ». Le fuzz a trouvé **deux multiplications qui ne sont PAS en
u128** et **un effet d'arrondi** qui contredit la lettre de la décision #7.

### F1 — `sell` : la multiplication de la taxe est en u64×u64 (overflow → panic)

**Où** : [`lib.rs:284`](programs/ephemere/src/lib.rs#L284)
```rust
let tax = gross_out * tax_bps / BPS_DENOM;   // gross_out: u64, tax_bps: u64
```
`gross_out` et `tax_bps` sont des `u64`. Le produit déborde `u64` dès que
`gross_out > u64::MAX / tax_bps`. Au plafond de taxe (2 500 bps) la falaise est
à `gross_out ≈ 7,38 × 10¹⁵` lamports, soit **≈ 7,38 M SOL** sortis en une seule
vente.

**Gravité** : faible. (a) Avec `overflow-checks = true` (activé dans le
`Cargo.toml` racine que j'ai ajouté), c'est un **panic propre** : la tx avorte,
rien ne bouge, aucun fonds volé. (b) C'est **contournable** : une vente plus
petite passe sous la falaise — le trader n'est jamais bloqué. (c) L'échelle
(7,38 M SOL en *une* vente) est irréaliste.

**Preuve** : `curve_fuzz.ts` → test « FINDINGS F1 ». Un whale dépose 9 M SOL,
puis une vente de 95 % de sa position (`gross ≈ 8,96e15 > cliff`) panique ; deux
ventes plus petites le sortent intégralement.

**Correctif proposé (1 ligne, n'altère aucun résultat dans la plage normale)** :
```rust
let tax = ((gross_out as u128) * (tax_bps as u128) / BPS_DENOM as u128) as u64;
```
Le résultat est **identique** partout où le code actuel ne déborde pas — c'est
purement défensif. Risque du correctif : nul.

---

### F2 — `resolve` : la multiplication de la fee est en u64×u64 (overflow → panic, NON contournable)

**Où** : [`lib.rs:424`](programs/ephemere/src/lib.rs#L424)
```rust
let fee = pot_total * ev.protocol_fee_bps as u64 / BPS_DENOM;  // pot_total: u64
```
Même classe de bug que F1, mais sur `resolve`. Au plafond de fee (1 000 bps) la
falaise est à `pot_total ≈ 1,84 × 10¹⁶` lamports, soit **≈ 18,4 M SOL** dans la
cagnotte.

**Gravité** : faible en probabilité, **mais qualitativement pire que F1**.
`resolve` **ne peut pas être découpé** : il n'y a qu'une résolution. Si la
cagnotte dépasse la falaise, `resolve` panique à chaque appel → l'event ne peut
jamais être résolu → `redeem` est **inatteignable** → les fonds des gagnants
sont gelés jusqu'à `sweep_unclaimed` (qui lui ne multiplie pas, donc finirait
par rendre la cagnotte à la treasury après la fenêtre — mais les holders
gagnants seraient lésés). C'est la seule instruction du protocole qui **ne doit
jamais pouvoir se bricker**.

**Preuve** : `curve_fuzz.ts` → test « FINDINGS F2 ». 20 M SOL parqués sur un
perdant, éliminé (le sweep ne multiplie pas, passe à toute taille) → cagnotte
≈ 2e16 → `resolve` panique, l'event reste `Active`, rien n'est perdu mais rien
n'avance.

**Correctif proposé (1 ligne)** :
```rust
let fee = ((pot_total as u128) * (ev.protocol_fee_bps as u128) / BPS_DENOM as u128) as u64;
```
Idem F1 : identique dans la plage normale, purement défensif.

**Recommandation** : si une seule des trois est corrigée, c'est F2 — l'asymétrie
« non contournable » la rend la plus importante des deux falaises, malgré
l'échelle improbable.

---

### F3 — l'arrondi du buy peut rendre un aller-retour légèrement profitable quand le prix unitaire dépasse ~1 lamport

C'est le finding le plus subtil et **le seul qui touche une décision VERROUILLÉE
à la lettre** (décision #7 : « Arrondis toujours contre le trader »). Je le
remonte au lieu de toucher à la curve.

**Mécanisme.** Au `buy`, `new_vtok = floor(k / (x + dx))`. Le floor *détruit* une
fraction de l'invariant : `k' = (x+dx)·floor(k/(x+dx)) ≤ k`. Or un `k` plus petit
**augmente** le `gross` de la revente (la revente reconstitue `vtok` à
l'identique mais avec un `k'` réduit, donc un `new_vsol` plus bas, donc un
`gross = vsol' − new_vsol − 1` plus haut). On montre :
```
gross(aller-retour) ≥ dx − 1,  et  gross − dx ≈ ⌈prix_unitaire_en_lamports⌉ − 1
```
- Quand `virtual_sol / virtual_tokens < 1 lamport` (régime sain) : le terme est
  nul → **aucun profit**, l'arrondi joue bien contre le trader. C'est le cas
  vérifié dans le test « round-trip » de la suite (13 montants, 0 tax : net ≤ coût).
- Quand le prix unitaire **dépasse 1 lamport** : un aller-retour peut rendre
  quelques lamports de **plus** que le coût. Le surplus est prélevé sur la
  réserve des *autres* déposants (le garde `gross_out <= real_reserve` garantit
  que le vault ne passe jamais négatif — la perte est socialisée, pas créée).

**Gravité** : négligeable économiquement, réelle formellement.
- Le profit est **borné par ~1 prix unitaire** par aller-retour.
- Chaque aller-retour coûte ~5 000 lamports de frais de tx → le grinding est
  **perdant** tant que le prix unitaire reste sous ~5 000 lamports.
- **Mais** ça contredit la lettre de #7, et à mauvaise calibration
  (`initial_virtual_tokens` trop petit) le prix unitaire grimpe vite.

**Preuve** : `curve_fuzz.ts` → test « FINDINGS F3 ». Curve volontairement
dégénérée (`vtok = 1e9`, prix unitaire ≈ 10 lamports) : recherche déterministe
d'un `dx`, aller-retour on-chain mesuré à **+11 lamports** (vs ~5 000 de frais).
Le profit on-chain égale exactement le profit modélisé.

**Ce n'est PAS un correctif de code que je propose** (changer l'arrondi du buy
= toucher la mécanique → interdit sans décision). Je propose une **contrainte de
calibration**, à ajouter à `tools/calibrate.py` et à documenter :
> Garder `initial_virtual_tokens` assez grand pour que le prix unitaire
> (`virtual_sol / virtual_tokens`) reste **sous 1 lamport** au plus haut dépôt
> anticipé. Concrètement, `initial_virtual_tokens ≥ 1e15` unités brutes
> (= 1 M tokens à 9 décimales) maintient le prix sub-lamport pour des dépôts
> jusqu'à ~1 M SOL par outcome. La config WC 2026 (48 outcomes) est très loin de
> la zone à risque.

À décider : (a) accepter le finding comme contrainte de calibration documentée
(mon avis : suffisant pour v1) ; ou (b) si on veut respecter #7 à la lettre même
en cas de mauvaise calibration, revoir l'arrondi du buy — mais c'est une
décision de design, pas un patch.

---

## Observations non-curve (frictions de compilation / outillage)

Aucune n'a touché la logique du contrat. Listées ici pour la revue finale, car
tu as demandé qu'on vérifie si elles ont un impact sur le contrat rédigé.

### O1 — `declare_id!` placeholder (corrigé, attendu par MISSIONS.md)
Le placeholder `EPHMRprotoco111…` n'est pas une base58 valide de 32 bytes.
Remplacé par une vraie keypair générée :
`4UxnYz4N5b5MnvMeGNqYGyvcu3izQYC7m6df9RhYTygo`. Keypair dans `target/deploy/`,
**hors repo**. Aucun impact logique. (MISSIONS.md Mission 1 le prévoyait.)

### O2 — `Cargo.toml` workspace racine absent du handoff (ajouté)
Le handoff n'avait pas de manifeste de workspace. Ajouté avec
`overflow-checks = true` en profil release : **décision d'ingénierie qui
interagit directement avec F1/F2** — c'est précisément ce flag qui transforme
les deux overflows en panics propres plutôt qu'en wraparounds silencieux (qui,
eux, *créeraient* des fonds : un `tax` ou `fee` wrappé serait énorme et
viderait la réserve / la cagnotte). **Recommandation forte : garder
`overflow-checks = true` en release**, indépendamment de la décision sur F1/F2.
À confirmer que c'était bien l'intention (le handoff ne le spécifiait pas).

### O3 — Épinglages de versions dans `Cargo.lock` (mécanique, sans impact logique)
platform-tools v1.51 embarque cargo/rustc 1.84.1, qui ne lit pas les crates
`edition2024`. Quatre downgrades transitifs ont été épinglés pour faire passer
le build SBF : `blake3 1.8.5→1.5.1`, `proc-macro-crate 3.5.0→3.1.0`,
`indexmap 2.14→2.7.1`, `unicode-segmentation 1.13.3→1.12.0`. Ce sont des
dépendances **de build**, aucune n'entre dans le binaire on-chain de façon
sémantiquement différente. Impact logique : nul. À re-vérifier si on bump
platform-tools.

### O4 — Outillage de test sous WSL (sans impact contrat)
`solana-bankrun` / `litesvm` n'ont pas de binding natif Windows (vérifié sur le
registre npm). Les tests tournent dans WSL Ubuntu (Node 18). `ts-mocha` remplacé
par `tsx` (chargement ESM des `.ts` sous Node 18). Purement runner de test.

---

## Récapitulatif des décisions en attente

| # | Finding | Sévérité | Décision | Statut |
|---|---------|----------|----------|--------|
| F1 | `sell` tax mult u64×u64 → panic @ ~7,4 M SOL | Faible (contournable, panic propre) | cast u128 | ✅ **Corrigé** (2026-06-11) |
| F2 | `resolve` fee mult u64×u64 → panic @ ~18,4 M SOL, **non contournable** | Faible proba, **brick possible** | cast u128 | ✅ **Corrigé** (2026-06-11) |
| F3 | arrondi buy → profit-dust si prix unitaire > 1 lamport (contredit #7 à la lettre) | Négligeable (borné ~1 prix unitaire, < frais tx) | contrainte de calibration, pas de patch curve en v1 | ✅ `check_f3` dans calibrate.py |
| O2 | `overflow-checks = true` en release | — | garder activé | ✅ Ratifié |

Bilan final : les deux casts u128 sont les **seules** modifications de logique
apportées à `lib.rs` depuis le handoff (avec la ligne `declare_id!`). Aucune
décision verrouillée n'a été touchée ; la décision #7 (arrondis contre le
trader) est précisée par une contrainte de calibration plutôt que modifiée.
