# CLAUDE.md — Éphémère Protocol

## Ce que tu construis

Le **Ephemeral Token Standard (ETS)** : un programme Anchor générique pour des "mortal outcome tokens". Un Event a N Outcomes mutuellement exclusifs (équipes, candidats, joueurs — le contrat ne connaît AUCUN sport). Chaque Outcome a son propre token tradable sur sa propre bonding curve native. Quand un Outcome est éliminé, son token MEURT : trading gelé à jamais, toute sa réserve SOL balayée dans une cagnotte commune scellée. À la résolution, le token gagnant devient un ticket de rédemption : burn contre une part pro-rata de la cagnotte en SOL. Après la fenêtre de claim, toute la supply de l'event peut être effacée de la chain (permanent delegate). Premier déploiement cible : Coupe du Monde 2026 (48 outcomes) — mais c'est une CONFIG, pas du code.

Le code de référence est dans `programs/ephemere/src/lib.rs`. Il est **spec-grade : la logique est finale, la compilation ne l'est pas**. Ta mission est de le faire compiler, le tester, et le durcir — PAS de redessiner l'architecture.

## Décisions architecturales VERROUILLÉES (ne pas "améliorer")

1. **Curve native, JAMAIS de pool Raydium/Orca/AMM externe.** Raison : un token listé sur un AMM externe est immortel — personne ne peut le tuer ni geler son trading. La mort programmée exige que le contrat soit l'unique venue. C'est le cœur du produit. Si tu penses qu'ajouter une LP améliore la liquidité : non, ça détruit le concept.
2. **Token-2022, UNE seule extension : PermanentDelegate**, pointée sur le PDA `[b"delegate"]` (aucune clé privée n'existe pour cette adresse). Pas de TransferHook (incompatible AMM et inutile ici), pas de TransferFee.
3. **Tous les paramètres économiques sont immuables après `initialize_event`.** Taxes, séquestration, fee, fenêtre de claim. C'est la promesse de confiance du protocole. Ne JAMAIS ajouter d'instruction admin qui les modifie.
4. **Le SOL d'une réserve n'a que deux sorties : `sell` (au prix de la curve, taxé) ou la cagnotte.** Aucun chemin vers l'authority ou la treasury depuis une réserve. La treasury n'est payée que par : la fee protocole (une fois, à `resolve`, plafond 10% hardcodé) et `sweep_unclaimed` (après la fenêtre).
5. **`resolve` exige `alive_count == 1`** : l'oracle est forcé d'éliminer explicitement chaque perdant avant de résoudre. Garde-fou contre une résolution frauduleuse silencieuse.
6. **`burn_residual` est impossible** tant qu'un outcome est vivant ou que la fenêtre de claim est ouverte. C'est LA réponse à "vous pouvez delete mes tokens ?" : seulement les tokens morts, seulement par la logique, jamais par une clé.
7. **Arrondis toujours contre le trader** : floor sur les tokens reçus au buy, ceil sur le new_vsol au sell. Protège la réserve contre le grinding.
8. **Séquestration = crank publique** (permissionless), une fois par market par round, avec markdown déterministe de `virtual_sol`. C'est le "sablier" : la valeur migre visiblement des marchés vers la cagnotte. Feature, pas bug.

## Le contexte économique (pourquoi ces mécaniques)

- Le problème résolu : les tokens d'événements (WC, élections) deviennent des zombies après l'event. ETS leur donne une mort propre et un settlement.
- Anti bank-run : sans séquestration ni taxe croissante, tous les holders vendraient avant la fin (le token va à zéro au settlement) et videraient les réserves = cagnotte vide. Le sablier + la taxe croissante + le gel pendant les matchs rendent la fuite tardive coûteuse et la cagnotte inévitable.
- Élimination = burn de supply + sweep de réserve. Pour les SURVIVANTS, une élimination doit être bullish (la rotation des capitaux des morts vers les vivants).
- ⚠️ Découverte de simulation critique : si `initial_virtual_sol` est trop petit vs les dépôts attendus, les acheteurs tardifs du CHAMPION perdent de l'argent (ils paient le token trop cher vs le taux de rédemption). Product-killer. Contrainte de calibration dure : **un acheteur de l'avant-dernier round du champion doit faire ≥ ×1,3**. Le script `tools/calibrate.py` vérifie ça.

## Stack & conventions

- Anchor 0.30.1, anchor-spl avec feature `token_2022`, Rust edition 2021.
- Tests en TypeScript (ts-mocha), localnet/devnet.
- Pas de dépendance externe non nécessaire. Le contrat doit rester auditable en une journée (< 1000 lignes).
- Le repo sera PUBLIC sous la marque Éphémère Labs, licence MIT. Qualité de code et commentaires d'invariants = vitrine.

## Tes missions, dans l'ordre (voir MISSIONS.md pour le détail)

1. Faire compiler (`anchor build`) — frictions attendues sur l'init des extensions Token-2022 et les versions de crates.
2. Suite de tests du CYCLE COMPLET : init → 4 outcomes → buy/sell → freeze → eliminate → sequester → advance_round → resolve → redeem → burn_residual → sweep.
3. Tests ADVERSES (les plus importants) : chaque invariant ci-dessus doit avoir un test qui PROUVE qu'on ne peut pas le violer.
4. Fuzzing léger de la curve (rounding, overflow u128, réserve jamais négative).
5. Script de déploiement devnet + simulation d'un mini-event complet.

## Ce que tu ne fais PAS

- Pas de frontend (projet séparé).
- Pas d'oracle service (projet séparé — l'authority sera un multisig Squads).
- Pas de mainnet. Jamais. Le déploiement mainnet passe par un audit externe humain d'abord.
- Pas de modification des mécaniques économiques sans demander. Si un choix te semble faux, EXPLIQUE le problème et propose — ne patch pas silencieusement.
