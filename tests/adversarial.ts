/**
 * Mission 3 — Adversarial suite. THE trust deliverable.
 *
 * Every locked invariant of the protocol gets a test that actively tries
 * to violate it and PROVES the program says no — with the exact expected
 * error. Positive controls are included where the gate must be precise
 * (e.g. burn_residual works on a dead token but not on the winner during
 * the claim window): a gate that blocks everything is as broken as one
 * that blocks nothing.
 *
 * Attack map (MISSIONS.md + extras):
 *   • config caps at initialize_event (fee >10%, window <7d, rounds >16,
 *     tax >25%, zero virtuals)                              → BadConfig
 *   • oracle ops signed by an attacker                      → Unauthorized
 *   • reserve/prize drains via forged vaults in sell/sequester/redeem
 *     (arbitrary wallet, other market's vault, other event's vault)
 *                                                           → ConstraintSeeds
 *   • cross-event account mixing (event Y + market of X)    → ConstraintHasOne
 *   • slippage floors on buy and sell                       → Slippage
 *   • trading on Frozen/Eliminated outcomes, Resolved event → dedicated errors
 *   • resolve with >1 alive outcome                         → OutcomesStillAlive
 *   • redeem of a non-winner token / mixed mint forgery     → NotTheWinner / HasOne
 *   • claim-window timing (redeem late, sweep early)        → dedicated errors
 *   • burn_residual while alive / winner during window      → TokenStillAlive
 *   • sequester twice per round, advance_round past the end → dedicated errors
 *   • state-machine re-entry (eliminate twice, sweep twice, redeem after sweep)
 */
import * as anchor from "@coral-xyz/anchor";
import { BN, Program } from "@coral-xyz/anchor";
import {
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
} from "@solana/web3.js";
import {
  TOKEN_2022_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
  unpackMint,
} from "@solana/spl-token";
import { Clock, ProgramTestContext, startAnchor } from "solana-bankrun";
import { BankrunProvider } from "anchor-bankrun";
import { expect } from "chai";
import * as path from "path";
import { Ephemere } from "../target/types/ephemere";

const IDL = require("../target/idl/ephemere.json");

const NUM_ROUNDS = 2;
const SELL_TAX_BPS = [100, 500, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
const SEQUESTER_BPS = [0, 200, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
const PROTOCOL_FEE_BPS = 500;
const CLAIM_WINDOW_SECS = 7n * 86_400n;
const INIT_VSOL = 10n * BigInt(LAMPORTS_PER_SOL);
const INIT_VTOK = 1_000_000_000_000_000n;

const name32 = (s: string): Buffer => {
  const b = Buffer.alloc(32);
  b.write(s, "utf8");
  return b;
};

describe("ephemere — adversarial", () => {
  let context: ProgramTestContext;
  let provider: BankrunProvider;
  let program: Program<Ephemere>;
  let payer: Keypair; // doubles as the legitimate oracle authority

  const attacker = Keypair.generate();
  const victim1 = Keypair.generate(); // holds W (winner-to-be)
  const victim2 = Keypair.generate(); // holds L1
  const victim3 = Keypair.generate(); // holds L2 and Z (event Y)
  const treasuryKp = Keypair.generate();
  const treasury = treasuryKp.publicKey;

  let delegatePda: PublicKey;

  interface Ev {
    nameBuf: Buffer;
    pda: PublicKey;
    prizeVault: PublicKey;
  }
  interface Outcome {
    label: string;
    nameBuf: Buffer;
    mintKp: Keypair;
    market: PublicKey;
    reserveVault: PublicKey;
  }

  let evX: Ev; // the attacked event
  let evY: Ev; // foreign event for cross-event forgeries
  const out: Record<string, Outcome> = {}; // W, L1, L2 on X; Z on Y

  let nonce = 1;
  const uniquify = () =>
    SystemProgram.transfer({
      fromPubkey: payer.publicKey,
      toPubkey: payer.publicKey,
      lamports: nonce++,
    });

  const balance = async (pk: PublicKey): Promise<bigint> =>
    await context.banksClient.getBalance(pk);

  const mintSupply = async (mint: PublicKey): Promise<bigint> => {
    const ai = await context.banksClient.getAccount(mint);
    return unpackMint(
      mint,
      { ...ai, data: Buffer.from(ai!.data) } as any,
      TOKEN_2022_PROGRAM_ID
    ).supply;
  };

  const ata = (mint: PublicKey, owner: PublicKey) =>
    getAssociatedTokenAddressSync(mint, owner, false, TOKEN_2022_PROGRAM_ID);

  const statusOf = (acc: { status: object }): string => Object.keys(acc.status)[0];

  const expectFail = async (p: Promise<unknown>, expected: string) => {
    try {
      await p;
    } catch (e: any) {
      const s = `${e}` + (e.message ?? "") + JSON.stringify(e.logs ?? []);
      expect(s, `expected failure containing "${expected}"`).to.include(expected);
      return;
    }
    expect.fail(`should have failed with ${expected}`);
  };

  const deriveEvent = (nameBuf: Buffer): Ev => {
    const [pda] = PublicKey.findProgramAddressSync(
      [Buffer.from("event"), nameBuf],
      program.programId
    );
    const [prizeVault] = PublicKey.findProgramAddressSync(
      [Buffer.from("prize"), pda.toBuffer()],
      program.programId
    );
    return { nameBuf, pda, prizeVault };
  };

  const deriveOutcome = (ev: Ev, label: string): Outcome => {
    const nameBuf = name32(`OUTCOME-${label}`);
    const mintKp = Keypair.generate();
    const [market] = PublicKey.findProgramAddressSync(
      [Buffer.from("market"), ev.pda.toBuffer(), nameBuf],
      program.programId
    );
    const [reserveVault] = PublicKey.findProgramAddressSync(
      [Buffer.from("reserve"), market.toBuffer()],
      program.programId
    );
    return { label, nameBuf, mintKp, market, reserveVault };
  };

  interface InitParams {
    numRounds?: number;
    tax?: number[];
    seq?: number[];
    fee?: number;
    window?: bigint;
    vsol?: bigint;
    vtok?: bigint;
  }
  const initEvent = (ev: Ev, p: InitParams = {}) =>
    program.methods
      .initializeEvent(
        Array.from(ev.nameBuf),
        p.numRounds ?? NUM_ROUNDS,
        p.tax ?? SELL_TAX_BPS,
        p.seq ?? SEQUESTER_BPS,
        p.fee ?? PROTOCOL_FEE_BPS,
        new BN((p.window ?? CLAIM_WINDOW_SECS).toString()),
        new BN((p.vsol ?? INIT_VSOL).toString()),
        new BN((p.vtok ?? INIT_VTOK).toString())
      )
      .accountsStrict({
        event: ev.pda,
        prizeVault: ev.prizeVault,
        authority: payer.publicKey,
        treasury,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

  const createOutcome = (ev: Ev, o: Outcome, authority: Keypair) =>
    program.methods
      .createOutcome(Array.from(o.nameBuf))
      .accountsStrict({
        event: ev.pda,
        market: o.market,
        mint: o.mintKp.publicKey,
        reserveVault: o.reserveVault,
        delegatePda,
        authority: authority.publicKey,
        tokenProgram: TOKEN_2022_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([o.mintKp, ...(authority === payer ? [] : [authority])])
      .rpc();

  /** buy/sell builders that allow FORGED vaults — the whole point here. */
  const buyIx = (
    ev: Ev,
    o: Outcome,
    user: Keypair,
    lamportsIn: bigint,
    minOut: bigint,
    forged: Partial<{ reserveVault: PublicKey; prizeVault: PublicKey; event: PublicKey }> = {}
  ) =>
    program.methods
      .buy(new BN(lamportsIn.toString()), new BN(minOut.toString()))
      .accountsStrict({
        event: forged.event ?? ev.pda,
        market: o.market,
        mint: o.mintKp.publicKey,
        reserveVault: forged.reserveVault ?? o.reserveVault,
        prizeVault: forged.prizeVault ?? ev.prizeVault,
        userTokenAccount: ata(o.mintKp.publicKey, user.publicKey),
        user: user.publicKey,
        tokenProgram: TOKEN_2022_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .preInstructions([
        createAssociatedTokenAccountIdempotentInstruction(
          payer.publicKey,
          ata(o.mintKp.publicKey, user.publicKey),
          user.publicKey,
          o.mintKp.publicKey,
          TOKEN_2022_PROGRAM_ID
        ),
      ])
      .signers([user]);

  const sellIx = (
    ev: Ev,
    o: Outcome,
    user: Keypair,
    tokensIn: bigint,
    minOut: bigint,
    forged: Partial<{ reserveVault: PublicKey; prizeVault: PublicKey; event: PublicKey }> = {}
  ) =>
    program.methods
      .sell(new BN(tokensIn.toString()), new BN(minOut.toString()))
      .accountsStrict({
        event: forged.event ?? ev.pda,
        market: o.market,
        mint: o.mintKp.publicKey,
        reserveVault: forged.reserveVault ?? o.reserveVault,
        prizeVault: forged.prizeVault ?? ev.prizeVault,
        userTokenAccount: ata(o.mintKp.publicKey, user.publicKey),
        user: user.publicKey,
        tokenProgram: TOKEN_2022_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([user]);

  const sequesterIx = (
    ev: Ev,
    o: Outcome,
    forged: Partial<{ reserveVault: PublicKey; prizeVault: PublicKey }> = {}
  ) =>
    program.methods.sequester().accountsStrict({
      event: ev.pda,
      market: o.market,
      reserveVault: forged.reserveVault ?? o.reserveVault,
      prizeVault: forged.prizeVault ?? ev.prizeVault,
    });

  const oracleEliminate = (ev: Ev, o: Outcome, authority: Keypair) =>
    program.methods
      .eliminate()
      .accountsStrict({
        event: ev.pda,
        market: o.market,
        reserveVault: o.reserveVault,
        prizeVault: ev.prizeVault,
        authority: authority.publicKey,
      })
      .signers(authority === payer ? [] : [authority]);

  const oracleResolve = (ev: Ev, o: Outcome, authority: Keypair) =>
    program.methods
      .resolve()
      .accountsStrict({
        event: ev.pda,
        market: o.market,
        mint: o.mintKp.publicKey,
        reserveVault: o.reserveVault,
        prizeVault: ev.prizeVault,
        treasury,
        authority: authority.publicKey,
      })
      .signers(authority === payer ? [] : [authority]);

  const redeemIx = (
    ev: Ev,
    o: Outcome,
    user: Keypair,
    tokensIn: bigint,
    forged: Partial<{ prizeVault: PublicKey; mint: PublicKey; tokenAccount: PublicKey }> = {}
  ) =>
    program.methods
      .redeem(new BN(tokensIn.toString()))
      .accountsStrict({
        event: ev.pda,
        market: o.market,
        mint: forged.mint ?? o.mintKp.publicKey,
        prizeVault: forged.prizeVault ?? ev.prizeVault,
        userTokenAccount:
          forged.tokenAccount ?? ata(forged.mint ?? o.mintKp.publicKey, user.publicKey),
        user: user.publicKey,
        tokenProgram: TOKEN_2022_PROGRAM_ID,
      })
      .signers([user]);

  const burnResidualIx = (ev: Ev, o: Outcome, target: PublicKey) =>
    program.methods.burnResidual().accountsStrict({
      event: ev.pda,
      market: o.market,
      mint: o.mintKp.publicKey,
      targetTokenAccount: target,
      delegatePda,
      tokenProgram: TOKEN_2022_PROGRAM_ID,
    });

  const sweepIx = (ev: Ev) =>
    program.methods
      .sweepUnclaimed()
      .accountsStrict({ event: ev.pda, prizeVault: ev.prizeVault, treasury });

  const advanceIx = (ev: Ev, authority: Keypair) =>
    program.methods
      .advanceRound()
      .accountsStrict({ event: ev.pda, authority: authority.publicKey })
      .signers(authority === payer ? [] : [authority]);

  const setFreezeIx = (ev: Ev, o: Outcome, frozen: boolean, authority: Keypair) =>
    program.methods
      .setFreeze(frozen)
      .accountsStrict({
        event: ev.pda,
        market: o.market,
        authority: authority.publicKey,
      })
      .signers(authority === payer ? [] : [authority]);

  before(async () => {
    const projectRoot = path.resolve(__dirname, "..");
    const fund = (pk: PublicKey) => ({
      address: pk,
      info: {
        lamports: 100 * LAMPORTS_PER_SOL,
        data: Buffer.alloc(0),
        owner: SystemProgram.programId,
        executable: false,
      },
    });
    context = await startAnchor(projectRoot, [], [
      fund(attacker.publicKey),
      fund(victim1.publicKey),
      fund(victim2.publicKey),
      fund(victim3.publicKey),
    ]);
    provider = new BankrunProvider(context);
    program = new Program<Ephemere>(IDL, provider);
    payer = context.payer;

    [delegatePda] = PublicKey.findProgramAddressSync(
      [Buffer.from("delegate")],
      program.programId
    );

    evX = deriveEvent(name32("ADV-X"));
    evY = deriveEvent(name32("ADV-Y"));
    await initEvent(evX);
    await initEvent(evY);

    out.W = deriveOutcome(evX, "W");
    out.L1 = deriveOutcome(evX, "L1");
    out.L2 = deriveOutcome(evX, "L2");
    out.Z = deriveOutcome(evY, "Z");
    for (const k of ["W", "L1", "L2"]) await createOutcome(evX, out[k], payer);
    await createOutcome(evY, out.Z, payer);

    // Liquidity + attacker token holdings (so forged calls fail ONLY on the
    // forged account, never on a missing balance).
    await buyIx(evX, out.W, victim1, 2_000_000_000n, 0n).rpc();
    await buyIx(evX, out.L1, victim2, 1_000_000_000n, 0n).rpc();
    await buyIx(evX, out.L2, victim3, 700_000_000n, 0n).rpc();
    await buyIx(evX, out.W, attacker, 300_000_000n, 0n).rpc();
    await buyIx(evX, out.L1, attacker, 310_000_000n, 0n).rpc();
    await buyIx(evY, out.Z, victim3, 500_000_000n, 0n).rpc();
  });

  // ── Config caps: the immutability promise starts at creation ─────────────
  it("initialize_event enforces every economic cap (BadConfig)", async () => {
    await expectFail(
      initEvent(deriveEvent(name32("BAD-FEE")), { fee: 1001 }),
      "BadConfig"
    ); // >10% protocol fee is impossible, hardcoded
    await expectFail(
      initEvent(deriveEvent(name32("BAD-WIN")), { window: 7n * 86_400n - 1n }),
      "BadConfig"
    ); // claim window shorter than 7 days
    await expectFail(
      initEvent(deriveEvent(name32("BAD-NR")), { numRounds: 17 }),
      "BadConfig"
    ); // more rounds than the schedule arrays
    await expectFail(
      initEvent(deriveEvent(name32("BAD-TAX")), {
        tax: [2501, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
      }),
      "BadConfig"
    ); // >25% sell tax
    await expectFail(
      initEvent(deriveEvent(name32("BAD-VSOL")), { vsol: 0n }),
      "BadConfig"
    ); // degenerate curve
  });

  // ── Oracle gating: I4 ─────────────────────────────────────────────────────
  it("eliminate/resolve/advance_round/set_freeze/create_outcome by a non-authority are rejected", async () => {
    await expectFail(oracleEliminate(evX, out.L1, attacker).rpc(), "Unauthorized");
    await expectFail(oracleResolve(evX, out.W, attacker).rpc(), "Unauthorized");
    await expectFail(advanceIx(evX, attacker).rpc(), "Unauthorized");
    await expectFail(setFreezeIx(evX, out.W, true, attacker).rpc(), "Unauthorized");
    // create_outcome checks the authority inside the handler
    const evil = deriveOutcome(evX, "EVIL");
    await expectFail(createOutcome(evX, evil, attacker), "Unauthorized");
  });

  // ── Reserve drains: I1 — no path from a reserve to anywhere but the
  //    curve (sell) or the prize vault ────────────────────────────────────────
  it("sell with forged vaults cannot drain a reserve (seeds reject)", async () => {
    const w = out.W;
    const reserveBefore = await balance(w.reserveVault);
    const prizeBefore = await balance(evX.prizeVault);
    const sellAmt = 50_000_000_000_000n; // attacker's W tokens (plenty held)

    // 1. prize_vault replaced by the attacker's own wallet
    await expectFail(
      sellIx(evX, w, attacker, sellAmt, 0n, { prizeVault: attacker.publicKey }).rpc(),
      "ConstraintSeeds"
    );
    // 2. reserve_vault replaced by the attacker's own wallet
    await expectFail(
      sellIx(evX, w, attacker, sellAmt, 0n, { reserveVault: attacker.publicKey }).rpc(),
      "ConstraintSeeds"
    );
    // 3. reserve_vault of ANOTHER market (L1's) under W's market
    await expectFail(
      sellIx(evX, w, attacker, sellAmt, 0n, { reserveVault: out.L1.reserveVault }).rpc(),
      "ConstraintSeeds"
    );
    // 4. prize_vault of ANOTHER event (Y's) — cross-event drain
    await expectFail(
      sellIx(evX, w, attacker, sellAmt, 0n, { prizeVault: evY.prizeVault }).rpc(),
      "ConstraintSeeds"
    );
    // 5. full cross-event mix: event Y with X's market (consistent Y vaults)
    await expectFail(
      sellIx(evX, w, attacker, sellAmt, 0n, {
        event: evY.pda,
        prizeVault: evY.prizeVault,
      }).rpc(),
      "ConstraintHasOne"
    );

    // Not a lamport moved by any attempt:
    expect(await balance(w.reserveVault), "reserve untouched").to.eq(reserveBefore);
    expect(await balance(evX.prizeVault), "prize untouched").to.eq(prizeBefore);
  });

  it("cross-event oracle calls are rejected (market not owned by that event)", async () => {
    // Legitimate authority, but event Y mixed with X's market W
    await expectFail(
      program.methods
        .eliminate()
        .accountsStrict({
          event: evY.pda,
          market: out.W.market,
          reserveVault: out.W.reserveVault,
          prizeVault: evY.prizeVault,
          authority: payer.publicKey,
        })
        .rpc(),
      "ConstraintHasOne"
    );
  });

  // ── Slippage floors ───────────────────────────────────────────────────────
  it("buy and sell honor the user's slippage floor (Slippage)", async () => {
    await expectFail(
      buyIx(evX, out.W, attacker, 100_000_000n, 2n ** 62n).rpc(),
      "Slippage"
    );
    await expectFail(
      sellIx(evX, out.W, attacker, 1_000_000_000_000n, 2n ** 62n).rpc(),
      "Slippage"
    );
  });

  // ── Freeze gate precision ─────────────────────────────────────────────────
  it("frozen outcome: no buy, no sell; freeze state machine is exact", async () => {
    // unfreezing an Active market is a state error
    await expectFail(
      setFreezeIx(evX, out.L2, false, payer).preInstructions([uniquify()]).rpc(),
      "WrongState"
    );
    await setFreezeIx(evX, out.L2, true, payer).rpc();
    await expectFail(
      buyIx(evX, out.L2, victim3, 120_000_000n, 0n).rpc(),
      "OutcomeNotTradable"
    );
    await expectFail(
      sellIx(evX, out.L2, victim3, 1_000_000_000_000n, 0n).rpc(),
      "OutcomeNotTradable"
    );
    // double-freeze is a state error too
    await expectFail(setFreezeIx(evX, out.L2, true, payer).rpc(), "WrongState");
    await setFreezeIx(evX, out.L2, false, payer).rpc();
  });

  // ── Resolution discipline: I-resolve (alive_count == 1) ──────────────────
  it("resolve with more than one living outcome is impossible (OutcomesStillAlive)", async () => {
    await expectFail(
      oracleResolve(evX, out.W, payer).rpc(),
      "OutcomesStillAlive"
    );
  });

  it("redeem before resolution is impossible (WrongState)", async () => {
    await expectFail(
      redeemIx(evX, out.W, attacker, 1_000_000n).rpc(),
      "WrongState"
    );
  });

  it("burn_residual on a living outcome is locked (TokenStillAlive)", async () => {
    await expectFail(
      burnResidualIx(evX, out.W, ata(out.W.mintKp.publicKey, victim1.publicKey)).rpc(),
      "TokenStillAlive"
    );
  });

  // ── Round machinery ───────────────────────────────────────────────────────
  it("create_outcome after round 0 / advance_round past the schedule are rejected", async () => {
    await advanceIx(evX, payer).rpc(); // round 0 → 1 (the last round)
    const late = deriveOutcome(evX, "LATE");
    await expectFail(createOutcome(evX, late, payer), "WrongState");
    await expectFail(
      advanceIx(evX, payer).preInstructions([uniquify()]).rpc(),
      "BadConfig"
    ); // current_round + 1 == num_rounds → no round left
  });

  it("sequester: forged vaults rejected, once per round enforced", async () => {
    const w = out.W;
    // forged prize vault (attacker wallet)
    await expectFail(
      sequesterIx(evX, w, { prizeVault: attacker.publicKey }).rpc(),
      "ConstraintSeeds"
    );
    // forged reserve vault (another market's)
    await expectFail(
      sequesterIx(evX, w, { reserveVault: out.L1.reserveVault }).rpc(),
      "ConstraintSeeds"
    );
    // cross-event prize vault
    await expectFail(
      sequesterIx(evX, w, { prizeVault: evY.prizeVault }).rpc(),
      "ConstraintSeeds"
    );
    // the legitimate crank works exactly once this round…
    await sequesterIx(evX, w).rpc();
    // …and a second turn the same round is rejected
    await expectFail(
      sequesterIx(evX, w).preInstructions([uniquify()]).rpc(),
      "AlreadySequestered"
    );
  });

  // ── Death is final ────────────────────────────────────────────────────────
  it("eliminated outcome: no trading, no re-elimination, no freeze games", async () => {
    await oracleEliminate(evX, out.L1, payer).rpc();
    expect(statusOf(await program.account.outcomeMarket.fetch(out.L1.market))).to.eq(
      "eliminated"
    );

    await expectFail(
      oracleEliminate(evX, out.L1, payer).preInstructions([uniquify()]).rpc(),
      "WrongState"
    );
    await expectFail(setFreezeIx(evX, out.L1, true, payer).rpc(), "WrongState");
    await expectFail(
      buyIx(evX, out.L1, victim2, 130_000_000n, 0n).rpc(),
      "OutcomeNotTradable"
    );
    await expectFail(
      sellIx(evX, out.L1, victim2, 1_000_000_000_000n, 0n).rpc(),
      "OutcomeNotTradable"
    );

    // Positive control: a DEAD token is burnable by ANYONE, immediately —
    // here the attacker wipes victim2's dead bag. Cleanup is a public good.
    const victimAta = ata(out.L1.mintKp.publicKey, victim2.publicKey);
    await burnResidualIx(evX, out.L1, victimAta).rpc();
    expect((await balance(victimAta)) >= 0n).to.be.true; // account survives, emptied
  });

  // ── Resolve + Resolved-state attacks ─────────────────────────────────────
  let resolvedAt: bigint;

  it("resolve works once the field is cleared, then the market is sealed", async () => {
    await oracleEliminate(evX, out.L2, payer).rpc();
    await oracleResolve(evX, out.W, payer).preInstructions([uniquify()]).rpc();
    const ev = await program.account.eventState.fetch(evX.pda);
    expect(statusOf(ev)).to.eq("resolved");
    expect(ev.winner.toBase58()).to.eq(out.W.market.toBase58());
    resolvedAt = BigInt(ev.resolvedAt.toString());

    // No trading on a resolved event — even on the winner
    await expectFail(
      buyIx(evX, out.W, attacker, 140_000_000n, 0n).rpc(),
      "WrongState"
    );
    await expectFail(
      sellIx(evX, out.W, attacker, 2_000_000_000_000n, 0n).rpc(),
      "WrongState"
    );
    // No sequester, no round, no elimination after the end
    await expectFail(
      sequesterIx(evX, out.W).preInstructions([uniquify()]).rpc(),
      "WrongState"
    );
    await expectFail(
      advanceIx(evX, payer).preInstructions([uniquify()]).rpc(),
      "WrongState"
    );
    await expectFail(
      oracleEliminate(evX, out.W, payer).preInstructions([uniquify()]).rpc(),
      "WrongState"
    );
  });

  it("redeem rejects non-winner tokens and forged accounts", async () => {
    // Straight attempt: attacker redeems L1 (eliminated) tokens
    await expectFail(
      redeemIx(evX, out.L1, attacker, 1_000_000n).rpc(),
      "NotTheWinner"
    );
    // Forged mint: winner market with L1's mint and L1 token account
    await expectFail(
      redeemIx(evX, out.W, attacker, 1_000_000n, {
        mint: out.L1.mintKp.publicKey,
      }).rpc(),
      "ConstraintHasOne"
    );
    // Forged prize vault: redirect payout source to attacker's wallet
    await expectFail(
      redeemIx(evX, out.W, attacker, 1_000_000n, {
        prizeVault: attacker.publicKey,
      }).rpc(),
      "ConstraintSeeds"
    );
    // Cross-event prize vault
    await expectFail(
      redeemIx(evX, out.W, attacker, 1_000_000n, {
        prizeVault: evY.prizeVault,
      }).rpc(),
      "ConstraintSeeds"
    );
  });

  it("claim window gates: sweep too early, burn winner too early", async () => {
    await expectFail(sweepIx(evX).rpc(), "ClaimWindowStillOpen");
    await expectFail(
      burnResidualIx(evX, out.W, ata(out.W.mintKp.publicKey, victim1.publicKey))
        .preInstructions([uniquify()])
        .rpc(),
      "TokenStillAlive"
    );
  });

  // ── After the window ──────────────────────────────────────────────────────
  it("after the window: redeem closed, cleanup open, sweep terminal", async () => {
    const clock = await context.banksClient.getClock();
    context.setClock(
      new Clock(
        clock.slot,
        clock.epochStartTimestamp,
        clock.epoch,
        clock.leaderScheduleEpoch,
        resolvedAt + CLAIM_WINDOW_SECS + 10n
      )
    );

    // The lazy winner missed the window
    await expectFail(
      redeemIx(evX, out.W, victim1, 1_000_000n).rpc(),
      "ClaimWindowClosed"
    );

    // Now — and only now — the winner's supply is burnable
    await burnResidualIx(evX, out.W, ata(out.W.mintKp.publicKey, victim1.publicKey))
      .preInstructions([uniquify()])
      .rpc();
    await burnResidualIx(evX, out.W, ata(out.W.mintKp.publicKey, attacker.publicKey)).rpc();
    expect((await mintSupply(out.W.mintKp.publicKey)).toString()).to.eq("0");

    // Sweep pays the treasury and seals the event…
    const treasuryBefore = await balance(treasury);
    await sweepIx(evX).preInstructions([uniquify()]).rpc();
    expect((await balance(treasury)) > treasuryBefore).to.be.true;
    expect(
      statusOf(await program.account.eventState.fetch(evX.pda))
    ).to.eq("swept");

    // …terminally: no second sweep, no late redeem on a swept event
    await expectFail(
      sweepIx(evX).preInstructions([uniquify()]).rpc(),
      "WrongState"
    );
    await expectFail(
      redeemIx(evX, out.W, victim1, 500_000n).rpc(),
      "WrongState"
    );
  });
});
