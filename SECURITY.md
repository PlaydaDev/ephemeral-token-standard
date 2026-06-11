# Security Policy — Éphémère Protocol

## Status

**v0.1 — reference implementation. Unaudited. Not deployed on mainnet.**
Mainnet deployment will not happen before an independent external audit; any
contract claiming to be an Éphémère mainnet instance before that is not ours.

Current devnet deployment (for lifecycle verification only, no real funds):
program `4UxnYz4N5b5MnvMeGNqYGyvcu3izQYC7m6df9RhYTygo` — see
[DEVNET_PROOF.md](DEVNET_PROOF.md).

## Reporting a vulnerability

- **Preferred**: GitHub → *Security* → *Report a vulnerability* (private
  advisory on this repository).
- Please do NOT open public issues for exploitable findings.
- Include: affected instruction(s), preconditions, a minimal reproduction
  (the bankrun test harness in `tests/` makes this easy), and impact.

We aim to acknowledge reports within 72 hours.

## Scope

In scope — the on-chain program (`programs/ephemere`):

| Class | Examples |
|---|---|
| Loss of funds | draining an outcome reserve or the prize vault outside `sell`/`redeem`/`sweep_unclaimed` semantics |
| Unauthorized supply ops | minting outside `buy`, burning live tokens via the permanent delegate |
| Gate bypass | trading on a dead/frozen outcome, resolving with >1 outcome alive, redeeming a non-winner, sweeping before the claim window |
| Math | curve rounding exploitable beyond the documented dust bound, overflow paths that move funds |
| Account forgery | seed/has_one confusions accepting foreign vaults or cross-event accounts |

Out of scope:

- **Oracle misbehavior.** The oracle authority is the protocol's residual
  trust point by design (see README, *Trust model*). Label requirement:
  multisig or optimistic oracle. A malicious oracle is a deployment-
  configuration failure, not a contract vulnerability.
- Already-documented behavior in [FINDINGS.md](FINDINGS.md) (u64 multiplication
  cliffs F1/F2, the sub-lamport rounding corner F3) — unless you can escalate
  one beyond its documented bound.
- Frontends, off-chain oracle services, RPC infrastructure (separate projects).
- Devnet instances and their parameters.

## Future bug bounty

A paid bounty program will open together with the external audit, before any
mainnet deployment. Scope and rewards will be published here. Findings
reported before the program opens will be honored retroactively at the
maintainers' discretion — early reporters will not be disadvantaged.

## Deployment requirements (for any instance claiming the Éphémère label)

1. Upgrade authority burned, or behind a publicly disclosed timelock.
2. Oracle authority = multisig (e.g. Squads) or optimistic oracle — never a
   single hot key.
3. All economic parameters and oracle signers published before trading opens.
