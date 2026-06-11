# DECISIONS.md — Alternatives étudiées et REJETÉES (ne pas réintroduire)

Journal du raisonnement de design. Chaque entrée = une voie explorée, pourquoi elle est morte. Si tu (Claude Code, ou un contributeur) as l'idée de réintroduire l'une d'elles : la réponse est déjà non, et voici pourquoi.

## R1 — Token unique + LP Raydium, burn des pools perdants, "récupération de la LP" à la fin
Rejeté. (a) Drainer la LP à la fin = rug au niveau protocole : tous les holders non-gagnants servent d'exit liquidity. (b) Le burn de tokens hors-LP ne crée AUCUNE valeur réelle — il gonfle un market cap fictif ; le seul argent réel est le SOL des réserves. (c) Bank run terminal : tout holder rationnel vend avant le settlement, la "cagnotte" s'évapore avant distribution, MEV massif sur la dernière fenêtre.

## R2 — Transfer Hooks (Token-2022) comme cœur du mécanisme
Rejeté. Les hooks sont incompatibles avec les AMM majeurs (Raydium CPMM ne supporte que TransferFee/Metadata) ET inutiles ici : le lock de paris se fait par escrow PDA, pas par hook. On garde Token-2022 uniquement pour PermanentDelegate (le nettoyage terminal), qui n'est viable QUE parce qu'on n'a pas besoin d'AMM externe.

## R3 — Settlement "cosmétique" (badges, NFT commémoratifs, pas de redistribution réelle)
Rejeté par décision produit explicite du fondateur : la carotte doit être réelle (SOL). Conservé comme note : c'était l'option à risque réglementaire minimal.

## R4 — Token unique + staking par équipe (vaults + comptes Position + multiplicateur temporel)
Rejeté au profit du design final. La tension token-qui-moon vs token-qui-meurt exigeait une ingénierie lourde (séquestration calibrée au millimètre, comptes Position, multiplicateurs). Le design 1-token-par-outcome dissout la tension : le token EST le pari, le prix EST la cote, vendre EST le cash-out. Moins de code, plus de produit (48 tribus).

## R5 — LMSR (market maker de prediction market) pour pricer les outcomes
Reporté en v2, pas rejeté sur le fond. Plus propre mathématiquement (probas qui somment à 100%, pas d'arbitrage incohérent) mais plus lourd à implémenter, auditer et expliquer. v1 = curves indépendantes ; l'incohérence des probas implicites est invisible pour la cible.

## R6 — Multiplicateur temporel de mise (early stakers pèsent plus)
Abandonné en v1 : la bonding curve fournit déjà la prime à l'entrée précoce (tokens moins chers tôt = plus de tokens par SOL = plus grosse part du pot). Doublonner avec un multiplicateur compliquait le contrat.

## R7 — Oracle = clé unique de l'opérateur
Rejeté comme configuration acceptable. L'oracle est LE point de confiance résiduel ; une clé unique fait de l'opérateur un bookmaker pouvant settle frauduleusement. Exigence du label Éphémère : multisig (Squads) minimum, oracle optimiste en cible v2. Le contrat reste agnostique (authority = Pubkey) mais la doc impose la norme.

## R8 — Vente directe au contrat sans taxe / pot adossé au marché ouvert
Rejeté. Sans friction de sortie croissante ni séquestration, le pot est un seau percé : les ventes tardives drainent les réserves avant les sweeps d'élimination. Les trois parades sont indissociables : taxe croissante par round + sablier (séquestration) + gel pendant les matchs.

## Contraintes économiques validées par simulation (juin 2026)
- Multiples gagnants ≈ rétention / part des mises sur le champion (×2,4–3,3 favori, ×47–66 outsider à 1%) — quasi indépendants du volume total. Cohérent avec des cotes de marché, légèrement sous bookmaker : la value prop n'est pas la cote, c'est la LIQUIDITÉ du pari + la prime early + l'aspect tribal.
- ⚠️ `initial_virtual_sol` trop petit vs dépôts attendus = les acheteurs tardifs du champion PERDENT (×0,2–0,7 constaté en simu avec ratio 1:20). Contrainte dure de calibration : acheteur de l'avant-dernier round du champion ≥ ×1,3. Ratio sain constaté : virtual_sol initial ≈ 1× les dépôts attendus par outcome favori (donne ×5,3 groupes → ×1,7 finale). Voir tools/calibrate.py.
