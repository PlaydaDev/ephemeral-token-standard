#!/usr/bin/env python3
"""
Éphémère Protocol — calibrateur de paramètres de launch.
Usage: python3 calibrate.py

Prend des hypothèses de dépôts et leur répartition temporelle, et vérifie
la contrainte produit dure :
  ► un acheteur du champion à l'AVANT-DERNIER round doit faire ≥ MIN_LATE_X
    (sinon "j'ai backé le vainqueur et j'ai perdu" => produit mort)
tout en gardant une prime early attractive (premier round ≥ EARLY_TARGET_X).

Modèle: curve constant-product à réserves virtuelles, identique au contrat.
Simplifications volontaires: pas de sells intra-event sur le champion (les
sells réduisent la supply ET la réserve — effet ~neutre sur la rédemption),
séquestration appliquée comme rétention globale.
"""

# ── HYPOTHÈSES À ÉDITER ──────────────────────────────────────────────────────
TOTAL_DEPOSITS_SOL = 10_000      # dépôts bruts attendus sur tout l'event
CHAMPION_SHARE     = 0.20        # part des dépôts finissant sur le champion
RETENTION          = 0.65        # part jamais ressortie par les ventes
PROTOCOL_FEE_BPS   = 500
# Répartition temporelle des dépôts sur le token champion, par round:
ROUND_FLOW = [("Groupes", 0.30), ("R32/R16", 0.25), ("Quarts", 0.20),
              ("Demies", 0.15), ("Finale", 0.10)]
MIN_LATE_X     = 1.3             # contrainte dure (avant-dernier round)
EARLY_TARGET_X = 3.0             # prime early souhaitée (1er round)
VTOK0          = 1_000_000_000 * 10**0   # réserve virtuelle tokens (unités)
# ─────────────────────────────────────────────────────────────────────────────

def simulate(vsol0: float):
    champ_dep = TOTAL_DEPOSITS_SOL * CHAMPION_SHARE
    pot = TOTAL_DEPOSITS_SOL * RETENTION * (1 - PROTOCOL_FEE_BPS / 10_000)
    k = vsol0 * VTOK0
    vsol, vtok = vsol0, VTOK0
    cohorts = []
    for name, frac in ROUND_FLOW:
        dep = champ_dep * frac
        nvsol = vsol + dep
        nvtok = k / nvsol
        cohorts.append((name, dep, vtok - nvtok))
        vsol, vtok = nvsol, nvtok
    supply = sum(t for _, _, t in cohorts)
    rate = pot / supply
    return [(n, d, (t * rate) / d) for n, d, t in cohorts], pot

def main():
    print(f"Dépôts {TOTAL_DEPOSITS_SOL} SOL | champion {CHAMPION_SHARE:.0%} | "
          f"rétention {RETENTION:.0%} | fee {PROTOCOL_FEE_BPS} bps\n")
    best = None
    for ratio in [0.25, 0.5, 0.75, 1.0, 1.5, 2.0, 3.0, 5.0]:
        vsol0 = TOTAL_DEPOSITS_SOL * CHAMPION_SHARE * ratio
        cohorts, pot = simulate(vsol0)
        early_x, late_x = cohorts[0][2], cohorts[-2][2]
        ok = late_x >= MIN_LATE_X
        tag = "OK " if ok else "KO "
        print(f"[{tag}] virtual_sol={vsol0:>8.0f} (ratio {ratio:>4}) | "
              + " | ".join(f"{n} x{x:.1f}" for n, _, x in cohorts))
        if ok and (best is None or abs(early_x - EARLY_TARGET_X) <
                   abs(best[1] - EARLY_TARGET_X)):
            best = (vsol0, early_x, late_x, pot)
    print()
    if best:
        vsol0, ex, lx, pot = best
        print(f"► RECOMMANDATION: initial_virtual_sol = {vsol0:.0f} SOL "
              f"({int(vsol0 * 1e9)} lamports), initial_virtual_tokens = {int(VTOK0)}")
        print(f"  Prime early x{ex:.1f}, avant-dernier round x{lx:.1f} "
              f"(contrainte ≥ x{MIN_LATE_X}), pot net ≈ {pot:,.0f} SOL")
        print("  NB: vsol0 s'applique PAR OUTCOME — les outsiders auront le même,")
        print("  ce qui rend leurs curves très plates au départ (cotes longues lisibles).")
    else:
        print("► Aucune config ne satisfait la contrainte: augmenter le ratio ou la rétention.")

if __name__ == "__main__":
    main()
