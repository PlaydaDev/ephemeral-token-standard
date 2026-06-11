/**
 * Mission 2 — Full lifecycle test (nominal path).
 *
 * 4 outcomes (A, B, C, D), 3 rounds, on anchor-bankrun (in-process bank,
 * full clock control). Every on-chain mutation is checked against an
 * independent BigInt mirror of the curve math — the test re-derives the
 * exact formulas (floor on buy, ceil on sell, always against the trader)
 * instead of trusting hardcoded constants.
 *
 * Scenario (MISSIONS.md):
 *   1. initialize_event  (tax [100,500,1000], seq [0,200,300], fee 500 bps,
 *      claim window 7 days)
 *   2. create_outcome ×4 (PermanentDelegate = delegate PDA, mint auth = market)
 *   3. buys on A, B, C (different amounts)
 *   4. partial sell on B (net out, tax → prize vault, virtuals updated)
 *   5. freeze C → buy fails → unfreeze
 *   6. advance_round → sequester ×4 (markdown checked), double call fails,
 *      next round re-allows
 *   7. eliminate D (empty reserve) then C (reserve fully swept), buy C fails
 *   8. eliminate B, resolve A (fee → treasury, snapshots frozen)
 *   9. redeem by A holder (payout = tokens × pot / supply, tokens burned)
 *  10. warp past claim window: redeem fails, burn_residual wipes all
 *      remaining balances, supplies hit 0
 *  11. sweep_unclaimed (residue → treasury, event Swept)
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
  getPermanentDelegate,
  unpackAccount,
  unpackMint,
} from "@solana/spl-token";
import { Clock, ProgramTestContext, startAnchor } from "solana-bankrun";
import { BankrunProvider } from "anchor-bankrun";
import { expect } from "chai";
import * as path from "path";
import { Ephemere } from "../target/types/ephemere";

const IDL = require("../target/idl/ephemere.json");

// ─── Event parameters (MISSIONS.md step 1) ──────────────────────────────────
const NUM_ROUNDS = 3;
const SELL_TAX_BPS = [100, 500, 1000, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
const SEQUESTER_BPS = [0, 200, 300, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
const PROTOCOL_FEE_BPS = 500;
const CLAIM_WINDOW_SECS = 7n * 86_400n;
const INIT_VSOL = 10n * BigInt(LAMPORTS_PER_SOL); // 10 SOL virtual
const INIT_VTOK = 1_000_000_000_000_000n; // 1M tokens @ 9 decimals
const BPS = 10_000n;

// ─── BigInt mirror of the on-chain curve (must match lib.rs exactly) ───────
class MarketModel {
  vsol = INIT_VSOL;
  vtok = INIT_VTOK;
  reserve = 0n;

  // dy = y - floor(k / (x + dx)) — floor rounds against the buyer
  buy(lamportsIn: bigint): bigint {
    const k = this.vsol * this.vtok;
    const newVsol = this.vsol + lamportsIn;
    const newVtok = k / newVsol;
    const out = this.vtok - newVtok;
    this.vsol = newVsol;
    this.vtok = newVtok;
    this.reserve += lamportsIn;
    return out;
  }

  // new_vsol = floor(k / (y + dy)) + 1 — ceil rounds against the seller
  sell(tokensIn: bigint, taxBps: bigint): { gross: bigint; tax: bigint; net: bigint } {
    const k = this.vsol * this.vtok;
    const newVtok = this.vtok + tokensIn;
    const newVsol = k / newVtok + 1n;
    const gross = this.vsol - newVsol;
    const tax = (gross * taxBps) / BPS;
    this.vsol = newVsol;
    this.vtok = newVtok;
    this.reserve -= gross;
    return { gross, tax, net: gross - tax };
  }

  sequester(bps: bigint): bigint {
    const amount = (this.reserve * bps) / BPS;
    if (amount > 0n) {
      const newVsol = (this.vsol * (BPS - bps)) / BPS;
      this.vsol = newVsol > 1n ? newVsol : 1n;
      this.reserve -= amount;
    }
    return amount;
  }
}

const name32 = (s: string): Buffer => {
  const b = Buffer.alloc(32);
  b.write(s, "utf8");
  return b;
};

describe("ephemere — full lifecycle", () => {
  let context: ProgramTestContext;
  let provider: BankrunProvider;
  let program: Program<Ephemere>;
  let payer: Keypair;

  const user1 = Keypair.generate(); // buys A (the future winner)
  const user2 = Keypair.generate(); // buys B, partial sell
  const user3 = Keypair.generate(); // buys C
  const treasuryKp = Keypair.generate();
  const treasury = treasuryKp.publicKey;

  const EVENT_NAME = name32("LIFECYCLE-TEST");
  let eventPda: PublicKey;
  let prizeVault: PublicKey;
  let delegatePda: PublicKey;
  let rent0: bigint; // rent-exempt floor of a 0-byte vault (the on-chain rent_floor)

  interface Outcome {
    label: string;
    nameBuf: Buffer;
    mintKp: Keypair;
    market: PublicKey;
    reserveVault: PublicKey;
    model: MarketModel;
  }
  const outcomes: Record<string, Outcome> = {};

  let nonce = 1; // unique self-transfer to de-duplicate otherwise-identical txs

  const uniquify = () =>
    SystemProgram.transfer({
      fromPubkey: payer.publicKey,
      toPubkey: payer.publicKey,
      lamports: nonce++,
    });

  const balance = async (pk: PublicKey): Promise<bigint> =>
    await context.banksClient.getBalance(pk);

  const mintInfo = async (mint: PublicKey) => {
    const ai = await context.banksClient.getAccount(mint);
    expect(ai, `mint ${mint.toBase58()} must exist`).to.not.be.null;
    return unpackMint(
      mint,
      { ...ai, data: Buffer.from(ai!.data) } as any,
      TOKEN_2022_PROGRAM_ID
    );
  };

  const tokenBalance = async (ata: PublicKey): Promise<bigint> => {
    const ai = await context.banksClient.getAccount(ata);
    if (!ai) return 0n;
    return unpackAccount(
      ata,
      { ...ai, data: Buffer.from(ai.data) } as any,
      TOKEN_2022_PROGRAM_ID
    ).amount;
  };

  const ata = (mint: PublicKey, owner: PublicKey) =>
    getAssociatedTokenAddressSync(mint, owner, false, TOKEN_2022_PROGRAM_ID);

  const statusOf = (acc: { status: object }): string =>
    Object.keys(acc.status)[0];

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

  const fetchMarket = (o: Outcome) => program.account.outcomeMarket.fetch(o.market);
  const fetchEvent = () => program.account.eventState.fetch(eventPda);

  /** Assert the on-chain market matches the BigInt mirror exactly. */
  const assertMarketMatchesModel = async (o: Outcome) => {
    const m = await fetchMarket(o);
    expect(m.virtualSol.toString(), `${o.label}.virtual_sol`).to.eq(o.model.vsol.toString());
    expect(m.virtualTokens.toString(), `${o.label}.virtual_tokens`).to.eq(o.model.vtok.toString());
    expect(m.realReserve.toString(), `${o.label}.real_reserve`).to.eq(o.model.reserve.toString());
    // Vault invariant: lamports = rent floor + tracked reserve, always.
    expect((await balance(o.reserveVault)).toString(), `${o.label} vault lamports`).to.eq(
      (rent0 + o.model.reserve).toString()
    );
  };

  const buy = (o: Outcome, user: Keypair, lamportsIn: bigint, minOut: bigint) =>
    program.methods
      .buy(new BN(lamportsIn.toString()), new BN(minOut.toString()))
      .accountsStrict({
        event: eventPda,
        market: o.market,
        mint: o.mintKp.publicKey,
        reserveVault: o.reserveVault,
        prizeVault: prizeVault,
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
      .signers([user])
      .rpc();

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
      fund(user1.publicKey),
      fund(user2.publicKey),
      fund(user3.publicKey),
    ]);
    provider = new BankrunProvider(context);
    program = new Program<Ephemere>(IDL, provider);
    payer = context.payer;

    [eventPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("event"), EVENT_NAME],
      program.programId
    );
    [prizeVault] = PublicKey.findProgramAddressSync(
      [Buffer.from("prize"), eventPda.toBuffer()],
      program.programId
    );
    [delegatePda] = PublicKey.findProgramAddressSync(
      [Buffer.from("delegate")],
      program.programId
    );

    for (const label of ["A", "B", "C", "D"]) {
      const nameBuf = name32(`OUTCOME-${label}`);
      const mintKp = Keypair.generate();
      const [market] = PublicKey.findProgramAddressSync(
        [Buffer.from("market"), eventPda.toBuffer(), nameBuf],
        program.programId
      );
      const [reserveVault] = PublicKey.findProgramAddressSync(
        [Buffer.from("reserve"), market.toBuffer()],
        program.programId
      );
      outcomes[label] = { label, nameBuf, mintKp, market, reserveVault, model: new MarketModel() };
    }
  });

  // ── 1. initialize_event ───────────────────────────────────────────────────
  it("initializes the event with the immutable economic schedule", async () => {
    await program.methods
      .initializeEvent(
        Array.from(EVENT_NAME),
        NUM_ROUNDS,
        SELL_TAX_BPS,
        SEQUESTER_BPS,
        PROTOCOL_FEE_BPS,
        new BN(CLAIM_WINDOW_SECS.toString()),
        new BN(INIT_VSOL.toString()),
        new BN(INIT_VTOK.toString())
      )
      .accountsStrict({
        event: eventPda,
        prizeVault: prizeVault,
        authority: payer.publicKey,
        treasury,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    const ev = await fetchEvent();
    expect(ev.authority.toBase58()).to.eq(payer.publicKey.toBase58());
    expect(ev.treasury.toBase58()).to.eq(treasury.toBase58());
    expect(statusOf(ev)).to.eq("active");
    expect(ev.currentRound).to.eq(0);
    expect(ev.numRounds).to.eq(NUM_ROUNDS);
    expect(ev.sellTaxBps).to.deep.eq(SELL_TAX_BPS);
    expect(ev.sequesterBps).to.deep.eq(SEQUESTER_BPS);
    expect(ev.protocolFeeBps).to.eq(PROTOCOL_FEE_BPS);
    expect(ev.claimWindowSecs.toString()).to.eq(CLAIM_WINDOW_SECS.toString());
    expect(ev.outcomeCount).to.eq(0);
    expect(ev.aliveCount).to.eq(0);

    // The prize vault starts at exactly the rent floor for 0 bytes — the
    // same floor resolve()/sweep_unclaimed() subtract before computing pot.
    rent0 = await balance(prizeVault);
    expect(rent0 > 0n).to.be.true;
  });

  // ── 2. create_outcome ×4 ──────────────────────────────────────────────────
  it("creates 4 outcomes: PermanentDelegate = delegate PDA, authorities = market PDA", async () => {
    for (const label of ["A", "B", "C", "D"]) {
      const o = outcomes[label];
      await program.methods
        .createOutcome(Array.from(o.nameBuf))
        .accountsStrict({
          event: eventPda,
          market: o.market,
          mint: o.mintKp.publicKey,
          reserveVault: o.reserveVault,
          delegatePda,
          authority: payer.publicKey,
          tokenProgram: TOKEN_2022_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .signers([o.mintKp])
        .rpc();

      const mint = await mintInfo(o.mintKp.publicKey);
      expect(mint.decimals, `${label} decimals`).to.eq(9);
      expect(mint.supply.toString(), `${label} initial supply`).to.eq("0");
      expect(mint.mintAuthority?.toBase58(), `${label} mint authority`).to.eq(o.market.toBase58());
      expect(mint.freezeAuthority?.toBase58(), `${label} freeze authority`).to.eq(o.market.toBase58());
      const pd = getPermanentDelegate(mint);
      expect(pd?.delegate.toBase58(), `${label} permanent delegate`).to.eq(delegatePda.toBase58());

      const m = await fetchMarket(o);
      expect(statusOf(m)).to.eq("active");
      expect(m.event.toBase58()).to.eq(eventPda.toBase58());
      expect(m.mint.toBase58()).to.eq(o.mintKp.publicKey.toBase58());
      expect(m.virtualSol.toString()).to.eq(INIT_VSOL.toString());
      expect(m.virtualTokens.toString()).to.eq(INIT_VTOK.toString());
      expect(m.realReserve.toString()).to.eq("0");
    }
    const ev = await fetchEvent();
    expect(ev.outcomeCount).to.eq(4);
    expect(ev.aliveCount).to.eq(4);
  });

  // ── 3. buys on A, B, C ────────────────────────────────────────────────────
  it("buys follow the curve formula exactly (floor against the buyer)", async () => {
    const purchases: Array<[Outcome, Keypair, bigint]> = [
      [outcomes.A, user1, 2_000_000_000n], // 2 SOL
      [outcomes.B, user2, 1_500_000_000n], // 1.5 SOL
      [outcomes.C, user3, 800_000_000n], // 0.8 SOL
    ];
    for (const [o, user, lamportsIn] of purchases) {
      const expectedOut = o.model.buy(lamportsIn);
      await buy(o, user, lamportsIn, expectedOut); // min_tokens_out = exact quote
      const got = await tokenBalance(ata(o.mintKp.publicKey, user.publicKey));
      expect(got.toString(), `${o.label} tokens received`).to.eq(expectedOut.toString());
      await assertMarketMatchesModel(o);
      const supply = (await mintInfo(o.mintKp.publicKey)).supply;
      expect(supply.toString(), `${o.label} supply == minted`).to.eq(expectedOut.toString());
    }
  });

  // ── 4. partial sell on B ──────────────────────────────────────────────────
  it("partial sell on B: net to seller, tax to prize vault, ceil against the seller", async () => {
    const o = outcomes.B;
    const userAta = ata(o.mintKp.publicKey, user2.publicKey);
    const tokensHeld = await tokenBalance(userAta);
    const tokensIn = tokensHeld / 2n;

    const taxBps = BigInt(SELL_TAX_BPS[0]); // round 0 ⇒ 100 bps
    const q = o.model.sell(tokensIn, taxBps);
    expect(q.tax > 0n, "scenario must exercise a non-zero tax").to.be.true;

    const userBefore = await balance(user2.publicKey);
    const prizeBefore = await balance(prizeVault);
    const supplyBefore = (await mintInfo(o.mintKp.publicKey)).supply;

    await program.methods
      .sell(new BN(tokensIn.toString()), new BN(q.net.toString()))
      .accountsStrict({
        event: eventPda,
        market: o.market,
        mint: o.mintKp.publicKey,
        reserveVault: o.reserveVault,
        prizeVault: prizeVault,
        userTokenAccount: userAta,
        user: user2.publicKey,
        tokenProgram: TOKEN_2022_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([user2])
      .rpc();

    // user2 is NOT the fee payer (provider wallet is), so the delta is the net payout
    expect((await balance(user2.publicKey)) - userBefore, "net to seller").to.eq(q.net);
    expect((await balance(prizeVault)) - prizeBefore, "tax to prize vault").to.eq(q.tax);
    expect((await tokenBalance(userAta)).toString()).to.eq((tokensHeld - tokensIn).toString());
    const supplyAfter = (await mintInfo(o.mintKp.publicKey)).supply;
    expect((supplyBefore - supplyAfter).toString(), "sold tokens burned").to.eq(tokensIn.toString());
    await assertMarketMatchesModel(o);
  });

  // ── 5. freeze / unfreeze ──────────────────────────────────────────────────
  it("freeze blocks trading on C; unfreeze restores it", async () => {
    const o = outcomes.C;
    await program.methods
      .setFreeze(true)
      .accountsStrict({ event: eventPda, market: o.market, authority: payer.publicKey })
      .rpc();
    expect(statusOf(await fetchMarket(o))).to.eq("frozen");

    await expectFail(buy(o, user3, 100_000_000n, 0n), "OutcomeNotTradable");

    await program.methods
      .setFreeze(false)
      .accountsStrict({ event: eventPda, market: o.market, authority: payer.publicKey })
      .rpc();
    expect(statusOf(await fetchMarket(o))).to.eq("active");
  });

  // ── 6. advance_round + sequester (the hourglass) ─────────────────────────
  it("sequester moves the scheduled slice to the pot with deterministic markdown", async () => {
    await program.methods
      .advanceRound()
      .accountsStrict({ event: eventPda, authority: payer.publicKey })
      .rpc();
    expect((await fetchEvent()).currentRound).to.eq(1);

    const sequesterIx = (o: Outcome) =>
      program.methods
        .sequester()
        .accountsStrict({
          event: eventPda,
          market: o.market,
          reserveVault: o.reserveVault,
          prizeVault: prizeVault,
        });

    const bps = BigInt(SEQUESTER_BPS[1]); // round 1 ⇒ 200 bps
    for (const label of ["A", "B", "C", "D"]) {
      const o = outcomes[label];
      const prizeBefore = await balance(prizeVault);
      const expected = o.model.sequester(bps);
      await sequesterIx(o).rpc();
      expect((await balance(prizeVault)) - prizeBefore, `${label} sequestered`).to.eq(expected);
      await assertMarketMatchesModel(o);
      expect((await fetchMarket(o)).lastSequesteredRound).to.eq(1);
    }
    // D never traded ⇒ slice of an empty reserve is 0, but the round is still marked
    expect(outcomes.D.model.reserve).to.eq(0n);

    // Second call in the same round must fail (the crank is once per round)
    await expectFail(
      sequesterIx(outcomes.A).preInstructions([uniquify()]).rpc(),
      "AlreadySequestered"
    );

    // Next round re-arms the crank (round 2 ⇒ 300 bps)
    await program.methods
      .advanceRound()
      .accountsStrict({ event: eventPda, authority: payer.publicKey })
      .rpc();
    expect((await fetchEvent()).currentRound).to.eq(2);
    const o = outcomes.A;
    const prizeBefore = await balance(prizeVault);
    const expected = o.model.sequester(BigInt(SEQUESTER_BPS[2]));
    await sequesterIx(o).rpc();
    expect((await balance(prizeVault)) - prizeBefore).to.eq(expected);
    await assertMarketMatchesModel(o);
  });

  // ── 7. eliminations ───────────────────────────────────────────────────────
  it("eliminate sweeps the whole reserve into the pot and kills trading", async () => {
    const eliminate = (o: Outcome) =>
      program.methods
        .eliminate()
        .accountsStrict({
          event: eventPda,
          market: o.market,
          reserveVault: o.reserveVault,
          prizeVault: prizeVault,
          authority: payer.publicKey,
        })
        .rpc();

    // D: empty reserve — elimination still works, sweeps 0
    await eliminate(outcomes.D);
    expect(statusOf(await fetchMarket(outcomes.D))).to.eq("eliminated");
    expect((await fetchEvent()).aliveCount).to.eq(3);

    // C: full reserve must land in the prize vault, vault drained to rent floor
    const c = outcomes.C;
    const cReserve = c.model.reserve;
    expect(cReserve > 0n).to.be.true;
    const prizeBefore = await balance(prizeVault);
    await eliminate(c);
    expect((await balance(prizeVault)) - prizeBefore, "C reserve swept").to.eq(cReserve);
    expect((await balance(c.reserveVault)).toString(), "C vault at rent floor").to.eq(rent0.toString());
    const cm = await fetchMarket(c);
    expect(statusOf(cm)).to.eq("eliminated");
    expect(cm.realReserve.toString()).to.eq("0");
    c.model.reserve = 0n;
    expect((await fetchEvent()).aliveCount).to.eq(2);

    // Dead token is dead: no more buys
    await expectFail(buy(c, user3, 50_000_000n, 0n), "OutcomeNotTradable");
  });

  // ── 8. resolve ────────────────────────────────────────────────────────────
  let potSnapshot: bigint;
  let supplySnapshot: bigint;
  let resolvedAt: bigint;

  it("resolve crowns the last survivor, takes the fee once, freezes snapshots", async () => {
    const eliminate = (o: Outcome) =>
      program.methods
        .eliminate()
        .accountsStrict({
          event: eventPda,
          market: o.market,
          reserveVault: o.reserveVault,
          prizeVault: prizeVault,
          authority: payer.publicKey,
        })
        .rpc();

    await eliminate(outcomes.B);
    outcomes.B.model.reserve = 0n;
    expect((await fetchEvent()).aliveCount).to.eq(1);

    const a = outcomes.A;
    const aReserve = a.model.reserve;
    const prizeBefore = await balance(prizeVault);
    const treasuryBefore = await balance(treasury);
    const supplyA = (await mintInfo(a.mintKp.publicKey)).supply;

    // Expected on-chain math: residual joins pot, then fee on the whole pot
    const potTotal = prizeBefore - rent0 + aReserve;
    const expectedFee = (potTotal * BigInt(PROTOCOL_FEE_BPS)) / BPS;

    await program.methods
      .resolve()
      .accountsStrict({
        event: eventPda,
        market: a.market,
        mint: a.mintKp.publicKey,
        reserveVault: a.reserveVault,
        prizeVault: prizeVault,
        treasury,
        authority: payer.publicKey,
      })
      .rpc();

    expect((await balance(treasury)) - treasuryBefore, "protocol fee to treasury").to.eq(expectedFee);
    expect((await balance(a.reserveVault)).toString(), "A vault at rent floor").to.eq(rent0.toString());

    const ev = await fetchEvent();
    expect(statusOf(ev)).to.eq("resolved");
    expect(ev.winner.toBase58()).to.eq(a.market.toBase58());
    expect(ev.prizePoolSnapshot.toString(), "pot snapshot").to.eq((potTotal - expectedFee).toString());
    expect(ev.winnerSupplySnapshot.toString(), "supply snapshot").to.eq(supplyA.toString());
    expect(ev.resolvedAt.toNumber()).to.be.greaterThan(0);
    expect(statusOf(await fetchMarket(a))).to.eq("winner");

    potSnapshot = BigInt(ev.prizePoolSnapshot.toString());
    supplySnapshot = BigInt(ev.winnerSupplySnapshot.toString());
    resolvedAt = BigInt(ev.resolvedAt.toString());
    a.model.reserve = 0n;

    // Prize vault now holds exactly rent floor + redeemable pot
    expect((await balance(prizeVault)).toString()).to.eq((rent0 + potSnapshot).toString());
  });

  // ── 9. redeem ─────────────────────────────────────────────────────────────
  it("redeem pays tokens × pot / supply at the frozen snapshot rate and burns", async () => {
    const a = outcomes.A;
    const userAta = ata(a.mintKp.publicKey, user1.publicKey);
    const held = await tokenBalance(userAta);
    const tokensIn = held / 2n; // keep the rest for the post-window burn_residual

    const expectedPayout = (tokensIn * potSnapshot) / supplySnapshot;
    const userBefore = await balance(user1.publicKey);
    const prizeBefore = await balance(prizeVault);

    await program.methods
      .redeem(new BN(tokensIn.toString()))
      .accountsStrict({
        event: eventPda,
        market: a.market,
        mint: a.mintKp.publicKey,
        prizeVault: prizeVault,
        userTokenAccount: userAta,
        user: user1.publicKey,
        tokenProgram: TOKEN_2022_PROGRAM_ID,
      })
      .signers([user1])
      .rpc();

    expect((await balance(user1.publicKey)) - userBefore, "redeem payout").to.eq(expectedPayout);
    expect(prizeBefore - (await balance(prizeVault))).to.eq(expectedPayout);
    expect((await tokenBalance(userAta)).toString()).to.eq((held - tokensIn).toString());
    const supply = (await mintInfo(a.mintKp.publicKey)).supply;
    expect(supply.toString(), "redeemed tokens burned").to.eq((held - tokensIn).toString());
  });

  // ── 10. claim window closes: redeem dies, burn_residual wipes the chain ──
  it("after the window: redeem fails, burn_residual erases every balance", async () => {
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

    const a = outcomes.A;
    const user1Ata = ata(a.mintKp.publicKey, user1.publicKey);
    const leftover = await tokenBalance(user1Ata);
    expect(leftover > 0n).to.be.true;

    await expectFail(
      program.methods
        .redeem(new BN(leftover.toString()))
        .accountsStrict({
          event: eventPda,
          market: a.market,
          mint: a.mintKp.publicKey,
          prizeVault: prizeVault,
          userTokenAccount: user1Ata,
          user: user1.publicKey,
          tokenProgram: TOKEN_2022_PROGRAM_ID,
        })
        .signers([user1])
        .rpc(),
      "ClaimWindowClosed"
    );

    // Permissionless cleanup of every remaining balance — including the
    // winner's, now that the window is over.
    const targets: Array<[Outcome, PublicKey]> = [
      [a, user1Ata],
      [outcomes.B, ata(outcomes.B.mintKp.publicKey, user2.publicKey)],
      [outcomes.C, ata(outcomes.C.mintKp.publicKey, user3.publicKey)],
    ];
    for (const [o, target] of targets) {
      expect((await tokenBalance(target)) > 0n, `${o.label} has residue to burn`).to.be.true;
      await program.methods
        .burnResidual()
        .accountsStrict({
          event: eventPda,
          market: o.market,
          mint: o.mintKp.publicKey,
          targetTokenAccount: target,
          delegatePda,
          tokenProgram: TOKEN_2022_PROGRAM_ID,
        })
        .rpc();
      expect((await tokenBalance(target)).toString(), `${o.label} account wiped`).to.eq("0");
    }

    // No zombies: every supply of the event is now zero (D never minted)
    for (const label of ["A", "B", "C", "D"]) {
      const supply = (await mintInfo(outcomes[label].mintKp.publicKey)).supply;
      expect(supply.toString(), `${label} supply zero`).to.eq("0");
    }
  });

  // ── 11. sweep_unclaimed ───────────────────────────────────────────────────
  it("sweep_unclaimed sends the residue to the treasury and seals the event", async () => {
    const prizeBefore = await balance(prizeVault);
    const treasuryBefore = await balance(treasury);
    const expectedRest = prizeBefore - rent0;
    expect(expectedRest > 0n, "unclaimed residue exists (user1 redeemed only half)").to.be.true;

    await program.methods
      .sweepUnclaimed()
      .accountsStrict({ event: eventPda, prizeVault: prizeVault, treasury })
      .rpc();

    expect((await balance(treasury)) - treasuryBefore, "residue to treasury").to.eq(expectedRest);
    expect((await balance(prizeVault)).toString(), "prize vault at rent floor").to.eq(rent0.toString());
    expect(statusOf(await fetchEvent())).to.eq("swept");
  });
});
