# MISSIONS.md — Backlog d'exécution Éphémère Protocol

Exécuter dans l'ordre. Ne pas passer à la mission suivante tant que la précédente n'est pas verte. À la fin de chaque mission : commit avec message descriptif.

---

## Mission 1 — Compilation (`anchor build` vert)

Le lib.rs est spec-grade. Frictions attendues et autorisées à corriger :
- Init du mint Token-2022 avec extension PermanentDelegate : l'ordre `create_account` → `initialize_permanent_delegate` → `initialize_mint2` est correct, mais les imports/signatures de `spl_token_2022` selon la version d'anchor-spl demanderont des ajustements. Si nécessaire, passer par `anchor_spl::token_2022_extensions` ou CPI manuelle avec `solana_program::program::invoke`.
- Le `declare_id!` placeholder doit être remplacé par une vraie keypair de programme (générer avec `anchor keys sync`).
- Contraintes Anchor sur les vaults program-owned (space=0, owner=crate::ID) : si `init` avec owner custom pose problème, créer le vault par CPI system_program dans le handler.
- `EventState::SIZE` / `OutcomeMarket::SIZE` : recompter après tout changement de struct. En cas de doute, utiliser `InitSpace`.
- Enums dans #[account] : vérifier que `EventStatus`/`OutcomeStatus` dérivent ce qu'Anchor 0.30 exige (`InitSpace` ou impls manuelles).

Interdit : changer la logique économique ou les checks pour "faire passer" la compilation. Si un check bloque la compilation, le problème est syntaxique, pas logique.

## Mission 2 — Tests du cycle de vie complet

Fichier `tests/lifecycle.ts`. Scénario nominal, 4 outcomes (A, B, C, D), 3 rounds :
1. `initialize_event` (taxes [100, 500, 1000, 0...], sequester [0, 200, 300, 0...], fee 500 bps, claim window 7 jours)
2. `create_outcome` ×4 — vérifier : mint a bien PermanentDelegate = PDA delegate, mint authority = market PDA
3. 3 users `buy` sur A, B, C (montants différents) — vérifier tokens reçus = formule curve, réserves correctes
4. Un user `sell` partiel sur B — vérifier net reçu, taxe arrivée dans prize vault, virtuals mis à jour
5. `set_freeze(C, true)` puis tentative de `buy` sur C → doit FAIL ; `set_freeze(C, false)`
6. `advance_round` → `sequester` sur A, B, C, D — vérifier montants, markdown de virtual_sol, double appel même round → FAIL
7. `eliminate(D)` (réserve vide) puis `eliminate(C)` — vérifier réserve de C intégralement dans le prize vault, status Eliminated, `buy` sur C → FAIL
8. `eliminate(B)`, puis `resolve(A)` — vérifier : fee → treasury, snapshots (pot, supply), status Resolved/Winner
9. `redeem` par les holders de A — vérifier payout = tokens × pot_snapshot / supply_snapshot, tokens brûlés
10. Warp après la fenêtre de claim : `redeem` → FAIL, `burn_residual` sur les comptes restants de A/B/C/D → OK, supplies à 0
11. `sweep_unclaimed` — vérifier résidu → treasury, status Swept

Astuce localnet : pour le warp temporel, utiliser `solana-test-validator --warp-slot` ou manipuler la clock via banks-client si bankrun est utilisé (préférer anchor-bankrun pour la vitesse et le contrôle de la clock).

## Mission 3 — Tests adverses (LE livrable de confiance)

Fichier `tests/adversarial.ts`. Chaque test prouve qu'un invariant tient. Tous doivent FAIL proprement avec l'erreur attendue :
- Drainer une réserve vers un wallet arbitraire (en forgeant les comptes de `sell`/`sequester` avec un faux prize_vault ou reserve_vault) → les contraintes de seeds doivent rejeter
- `eliminate`/`resolve`/`advance_round`/`set_freeze` signés par un non-authority → Unauthorized
- `resolve` avec 2 outcomes vivants → OutcomesStillAlive
- `redeem` avec le token d'un outcome non-winner → NotTheWinner
- `redeem` après la fenêtre / `sweep_unclaimed` avant la fin de fenêtre → erreurs dédiées
- `burn_residual` sur un outcome Active / sur le winner pendant la fenêtre → TokenStillAlive
- `buy`/`sell` sur outcome Eliminated/Frozen, ou event Resolved → erreurs dédiées
- `sequester` deux fois le même round → AlreadySequestered
- Slippage : `buy` avec min_tokens_out trop haut → Slippage
- Passer le prize_vault d'un AUTRE event dans `sell` (cross-event) → seeds doivent rejeter
- Tenter `create_outcome` après round > 0 ou par un non-authority → rejet

## Mission 4 — Robustesse de la curve

Fichier `tests/curve_fuzz.ts` (ou test Rust unitaire) :
- Propriété : pour toute séquence de buys/sells, `real_reserve` ≥ somme des sorties possibles, jamais de sous-flot
- Propriété : buy puis sell immédiat du même montant = perte nette pour le trader (arrondis + taxe) — jamais de profit d'aller-retour
- Extrêmes : 1 lamport, montants énormes (vérifier u128 partout dans les multiplications), réserve quasi vide
- Vérifier que le markdown de séquestration ne peut jamais mettre virtual_sol à 0

## Mission 5 — Devnet : event simulé de bout en bout

Script `scripts/devnet_demo.ts` : déploie, crée un event "DEMO" à 4 outcomes, exécute tout le cycle (avec de vrais délais courts), log toutes les signatures de tx dans `DEVNET_PROOF.md`. Ces signatures seront publiées dans le README comme preuve publique du cycle de mort. Garder la mnémonique du programme deployer hors du repo.

## Mission 6 — Hygiène de repo public

- `anchor build` + tests dans une GitHub Action (badge dans le README)
- `cargo clippy` clean, commentaires d'invariants préservés (ils font partie du produit)
- SECURITY.md : contact, périmètre du futur bug bounty
- Vérifier qu'AUCUNE référence à un sport/équipe réelle n'existe dans le code (générique = la promesse)

---

## Hors périmètre (NE PAS FAIRE)
Frontend, oracle service, déploiement mainnet, modification des mécaniques économiques, intégration DexScreener. Si une mécanique semble défectueuse : documenter le problème dans FINDINGS.md et demander, ne pas corriger silencieusement.
