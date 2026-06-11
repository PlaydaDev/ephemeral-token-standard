# Éphémère Protocol — Ephemeral Token Standard (ETS) v0.1

![ci](https://github.com/PlaydaDev/ephemeral-token-standard/actions/workflows/ci.yml/badge.svg)

**Built by Éphémère Labs · Open source (MIT) · Solana / Anchor / Token-2022**

> Every token here is born with a death date.

Éphémère is a generic, event-agnostic primitive for **mortal outcome tokens**: an event with N mutually-exclusive outcomes, one freely-tradable token per outcome, and a programmed end. Losers' liquidity migrates into a sealed prize vault; the winning token becomes a redemption ticket for the pot; every token of the event can then be erased from the chain. No zombies.

It is not a World Cup contract, not a football contract, not a sports contract. **It knows nothing about your event.** You bring the event; the protocol brings the lifecycle.

## The lifecycle

```
 create_outcome ×N          buy/sell (curve)         eliminate            resolve              redeem
┌──────────────────┐   ┌─────────────────────┐   ┌───────────────┐   ┌───────────────┐   ┌──────────────┐
│ N mortal tokens, │ → │ price = implied odds │ → │ token dies,   │ → │ last one      │ → │ burn winner  │
│ one per outcome  │   │ buy = bet            │   │ reserve swept │   │ standing wins │   │ token, get   │
│                  │   │ sell = cash-out      │   │ to prize pot  │   │ pot snapshot  │   │ SOL pro-rata │
└──────────────────┘   └─────────────────────┘   └───────────────┘   └───────────────┘   └──────────────┘
                          + per-round sequestration ("hourglass") and round-scaled sell tax → prize vault
                                                                       after claim window: burn_residual
                                                                       wipes every balance. Nothing remains.
```

## Economic mechanics

- **Native bonding curve per outcome** (constant product, virtual reserves). No external AMM, no LP — that's what makes death possible. The contract is the only venue.
- **Elimination sweep**: an eliminated outcome's *entire* SOL reserve moves to the common prize vault. The losers fund the winners — pure parimutuel, expressed as N tradable tokens.
- **The hourglass (sequestration)**: each round, a scheduled `sequester_bps` slice of every surviving reserve migrates to the pot, with a deterministic curve markdown. Published at creation, identical for everyone, priced in by the market. Permissionless crank.
- **Round-scaled sell tax**: exiting early is cheap; exiting late is expensive — and the tax goes to the pot. Quitters fund believers.
- **Resolution & redemption**: the winner's residual reserve joins the pot, the protocol fee (≤10% hard cap, disclosed at creation) is taken once, the redemption rate is frozen by snapshot. Burn winning tokens → receive SOL, during the claim window.
- **Terminal cleanup**: `burn_residual` lets *anyone* burn dead-token balances from *any* wallet via the permanent-delegate PDA — gated so it is impossible while a token is alive or claims are open. After the sweep, the event has left the chain.

## Trust model — verify, don't trust

| Invariant | Where |
|---|---|
| No path from any reserve to the operator. SOL leaves a reserve only via `sell` (curve price) or toward the prize vault | `sell`, `sequester`, `eliminate`, `resolve` |
| Prize vault pays only winners (`redeem`) or, after the full claim window, the treasury (`sweep_unclaimed`) | `redeem`, `sweep_unclaimed` |
| Protocol fee taken once, at resolution, capped at 1 000 bps | `resolve`, `initialize_event` |
| Mass burn impossible while a token is alive / claims open; permanent delegate is a keyless PDA | `burn_residual` |
| All economic parameters (tax & sequestration schedules, fee, claim window) immutable after creation | `initialize_event` |
| Resolution requires every other outcome to have been explicitly eliminated (`alive_count == 1`) | `resolve` |

**Deployment requirements for any instance claiming the Éphémère label:**
1. Upgrade authority **burned** (or behind a publicly disclosed timelock).
2. Oracle authority = **multisig** (e.g. Squads) or optimistic oracle — never a single hot key. The oracle is the residual trust point of this design; treat it accordingly.
3. Parameters and oracle signers published before trading opens.

## Integrating your event

The protocol is the chassis; your event logic lives off-chain and drives it through the oracle authority:

1. `initialize_event` — name, number of rounds, `sell_tax_bps[]` and `sequester_bps[]` schedules, protocol fee, claim window, initial virtual reserves (sets starting price & depth).
2. `create_outcome` × N — one mortal token per outcome (48 teams, 12 candidates, 10 drivers, 2 fighters…).
3. During the event: `advance_round` per phase; `set_freeze` around live matches (close bets at kickoff like any bookmaker); `eliminate` when an outcome is out. `sequester` is a public crank — anyone can turn the hourglass.
4. `resolve` once a single outcome stands. Holders `redeem`. After the window: `sweep_unclaimed`, then `burn_residual` cranks until supply is zero.

A reference oracle service (multisig flow + sports-data adapters) and a reference frontend are out of scope of this repo by design: the contract must stay small enough to audit in a day.

## Parameters worth simulating before launch

- `initial_virtual_sol / initial_virtual_tokens` — starting price and curve depth per outcome.
- `sequester_bps[]` — the hourglass speed. Too fast: the markets bleed and the flywheel dies. Too slow: the pot is thin and the endgame run risk grows. Calibrate against expected staking participation so elimination burns (supply ↓) dominate sequestration (reserve ↓) and eliminations are *bullish* for survivors.
- `sell_tax_bps[]` — the exit-pressure dampener for late rounds.

## Build & test

```bash
anchor build                 # Anchor 0.30.1, Solana/Agave platform-tools
npm ci && npm test           # 34 tests: lifecycle, adversarial, curve fuzz (anchor-bankrun)
cargo clippy -p ephemere --all-targets -- -D warnings
```

Tests run in-process (anchor-bankrun) with full clock control — no validator
needed. On Windows, run them under WSL: `bash scripts/wsl-test.sh`
(solana-bankrun ships no win32 binding).

The full death cycle has been executed on devnet with publicly verifiable
transactions: see **[DEVNET_PROOF.md](DEVNET_PROOF.md)**.

## Status & security

⚠️ **v0.1 — reference implementation. Unaudited. Do not deploy to mainnet with real funds without an independent audit and a full devnet lifecycle test (create → trade → freeze → eliminate → sequester → resolve → redeem → burn → sweep).** Known sharp edges to review: lamport accounting on program-owned vaults, Token-2022 extension initialization order, rounding direction on curve math (floor on buys, ceil on sells — always against the trader). Behavior found and characterized by the fuzz suite is documented in [FINDINGS.md](FINDINGS.md).

Vulnerability reporting and bounty perimeter: see [SECURITY.md](SECURITY.md).

Operating an instance of this protocol may be regulated activity in your jurisdiction. Éphémère Labs publishes code, not legal cover. Know what you are deploying.

## License

MIT © Éphémère Labs

---

*Other launchpads ship immortal tokens that die of abandonment. Éphémère ships mortal tokens that die with dignity — and pay their believers.*
