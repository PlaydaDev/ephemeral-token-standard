/**
 * Mission 4 — Curve robustness. Property-based fuzz against the REAL
 * deployed program (not a reimplementation): a deterministic random walk
 * of buys/sells/sequesters with a BigInt mirror, checked step by step.
 *
 * Properties verified:
 *   P1. State fidelity: on-chain (virtual_sol, virtual_tokens, real_reserve)
 *       equals the mirror after every operation; vault lamports equal
 *       rent floor + tracked value (lamport conservation, both vaults).
 *   P2. Solvency: in the sane regime (unit price ≪ 1 lamport), selling the
 *       ENTIRE outstanding supply at once yields gross ≤ real_reserve, at
 *       every step. Chunked exits only yield less (each ceil rounds against
 *       the seller). Discharged for real by a full on-chain unwind at the
 *       end — no InsufficientReserve, ever. Outside the sane regime the
 *       on-chain `gross_out <= real_reserve` guard is the (effective) last
 *       line of defense — see F3.
 *   P3. virtual_sol ≥ 1 always; the sequester markdown can never zero it
 *       (when amount > 0 the markdown floor stays ≥ 1; the max(1) clamp is
 *       defense in depth).
 *   P4. No round-trip profit in the sane regime: buy then immediately sell
 *       the same tokens nets ≤ what was paid with zero tax (rounding
 *       alone), strictly less on a taxed round.
 *   P5. Extremes: 1-lamport buys, dust sells (0 lamports out, tokens
 *       burned — rounding against the trader by design), near-empty
 *       reserves, multi-million-SOL amounts.
 *
 * ⚠ FINDINGS pinned here (see FINDINGS.md — documented, NOT silently fixed):
 *   F1. sell: `gross_out * tax_bps` is u64×u64. Above gross ≈ u64::MAX /
 *       tax_bps (7.4M SOL at 25% tax) the multiplication overflows and
 *       panics: the tx aborts, funds are SAFE, and a smaller sell works.
 *   F2. resolve: `pot_total * protocol_fee_bps` is u64×u64. Above
 *       pot ≈ u64::MAX / fee_bps (18.4M SOL at the 10% cap) resolve
 *       panics — and resolve cannot be chunked. Implausible scale, but it
 *       is the one instruction that must never brick.
 *   F3. The buy floor burns a slice of k (k' = (x+dx)·⌊k/(x+dx)⌋ < k), and
 *       a smaller k RAISES the gross of the eventual unwind: when the unit
 *       price exceeds ~1 lamport (vsol+dx > vtok), a buy→sell-all round
 *       trip can net a few lamports MORE than it paid — paid out of other
 *       depositors' reserve. The `gross_out <= real_reserve` guard caps
 *       the damage (the vault can never underflow) and the profit is
 *       bounded by ~1 unit's price (dwarfed by the tx fee at sane
 *       configs), but "rounding always against the trader" is not an
 *       absolute: keep initial_virtual_tokens large (≥1e15 raw units) so
 *       the unit price stays sub-lamport at any plausible deposit size.
 */
import * as anchor from "@coral-xyz/anchor";
import { BN, Program } from "@coral-xyz/anchor";
import {
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
} from "@solana/web3.js";
import {
  TOKEN_2022_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
  unpackMint,
} from "@solana/spl-token";
import { ProgramTestContext, startAnchor } from "solana-bankrun";
import { BankrunProvider } from "anchor-bankrun";
import { expect } from "chai";
import * as path from "path";
import { Ephemere } from "../target/types/ephemere";

const IDL = require("../target/idl/ephemere.json");

const BPS = 10_000n;
const WALK_STEPS = 220;
const SEED = 0xef311; // fixed seed — the walk is fully deterministic

// Schedules for the walk event (16 rounds, caps included)
const WALK_TAX = [0, 100, 2500, 500, 1000, 2500, 0, 300, 700, 1500, 2000, 2500, 50, 0, 900, 2500];
const WALK_SEQ = [0, 200, 2500, 300, 0, 1000, 2500, 100, 400, 800, 1600, 2500, 0, 50, 600, 2500];

const name32 = (s: string): Buffer => {
  const b = Buffer.alloc(32);
  b.write(s, "utf8");
  return b;
};

// Deterministic PRNG (mulberry32)
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** BigInt mirror of the on-chain market math (must match lib.rs exactly). */
class Model {
  vsol: bigint;
  vtok: bigint;
  reserve = 0n;
  supply = 0n;
  prize = 0n; // lamports accrued to the prize vault (taxes + sequesters)

  constructor(vsol: bigint, vtok: bigint) {
    this.vsol = vsol;
    this.vtok = vtok;
  }

  clone(): Model {
    const m = new Model(this.vsol, this.vtok);
    m.reserve = this.reserve;
    m.supply = this.supply;
    m.prize = this.prize;
    return m;
  }

  quoteBuy(dx: bigint): bigint {
    const k = this.vsol * this.vtok;
    return this.vtok - k / (this.vsol + dx);
  }
  quoteSellGross(dy: bigint): bigint {
    const k = this.vsol * this.vtok;
    return this.vsol - (k / (this.vtok + dy) + 1n);
  }
  buy(dx: bigint): bigint {
    const k = this.vsol * this.vtok;
    const newVsol = this.vsol + dx;
    const newVtok = k / newVsol;
    const out = this.vtok - newVtok;
    this.vsol = newVsol;
    this.vtok = newVtok;
    this.reserve += dx;
    this.supply += out;
    return out;
  }
  sell(dy: bigint, taxBps: bigint): { gross: bigint; tax: bigint; net: bigint } {
    const k = this.vsol * this.vtok;
    const newVtok = this.vtok + dy;
    const newVsol = k / newVtok + 1n;
    const gross = this.vsol - newVsol;
    const tax = (gross * taxBps) / BPS;
    this.vsol = newVsol;
    this.vtok = newVtok;
    this.reserve -= gross;
    this.supply -= dy;
    this.prize += tax;
    return { gross, tax, net: gross - tax };
  }
  sequester(bps: bigint): bigint {
    const amount = (this.reserve * bps) / BPS;
    if (amount > 0n) {
      const newVsol = (this.vsol * (BPS - bps)) / BPS;
      this.vsol = newVsol > 1n ? newVsol : 1n;
      this.reserve -= amount;
      this.prize += amount;
    }
    return amount;
  }
  /** P2: gross of selling the whole supply at once — the max possible exit. */
  solvencyBound(): bigint {
    if (this.supply === 0n) return 0n;
    return this.quoteSellGross(this.supply);
  }
}

describe("ephemere — curve robustness (fuzz)", () => {
  let context: ProgramTestContext;
  let provider: BankrunProvider;
  let program: Program<Ephemere>;
  let payer: Keypair;

  const rand = mulberry32(SEED);
  const randInt = (lo: number, hi: number) => lo + Math.floor(rand() * (hi - lo + 1));

  const traders = [Keypair.generate(), Keypair.generate(), Keypair.generate(), Keypair.generate()];
  const whaleTax = Keypair.generate(); // F1 probe
  const whaleFee = Keypair.generate(); // F2 probe
  const small = Keypair.generate();
  const dummies = [Keypair.generate(), Keypair.generate(), Keypair.generate()];
  const treasury = Keypair.generate().publicKey;

  let delegatePda: PublicKey;
  let nonce = 1;
  const uniquify = () =>
    SystemProgram.transfer({
      fromPubkey: payer.publicKey,
      toPubkey: payer.publicKey,
      lamports: nonce++,
    });

  interface Ev {
    nameBuf: Buffer;
    pda: PublicKey;
    prizeVault: PublicKey;
    rent0: bigint;
  }
  interface Outcome {
    nameBuf: Buffer;
    mintKp: Keypair;
    market: PublicKey;
    reserveVault: PublicKey;
  }

  const balance = async (pk: PublicKey): Promise<bigint> =>
    await context.banksClient.getBalance(pk);

  const ata = (mint: PublicKey, owner: PublicKey) =>
    getAssociatedTokenAddressSync(mint, owner, false, TOKEN_2022_PROGRAM_ID);

  const mintSupply = async (mint: PublicKey): Promise<bigint> => {
    const ai = await context.banksClient.getAccount(mint);
    return unpackMint(mint, { ...ai, data: Buffer.from(ai!.data) } as any, TOKEN_2022_PROGRAM_ID)
      .supply;
  };

  const expectFailAny = async (p: Promise<unknown>, accepted: string[]) => {
    try {
      await p;
    } catch (e: any) {
      const s = `${e}` + (e.message ?? "") + JSON.stringify(e.logs ?? []);
      expect(
        accepted.some((a) => s.includes(a)),
        `error should contain one of [${accepted}], got: ${s.slice(0, 400)}`
      ).to.be.true;
      return;
    }
    expect.fail(`should have failed with one of [${accepted}]`);
  };

  const deriveEvent = (name: string): Ev => {
    const nameBuf = name32(name);
    const [pda] = PublicKey.findProgramAddressSync(
      [Buffer.from("event"), nameBuf],
      program.programId
    );
    const [prizeVault] = PublicKey.findProgramAddressSync(
      [Buffer.from("prize"), pda.toBuffer()],
      program.programId
    );
    return { nameBuf, pda, prizeVault, rent0: 0n };
  };

  const deriveOutcome = (ev: Ev, label: string): Outcome => {
    const nameBuf = name32(label);
    const mintKp = Keypair.generate();
    const [market] = PublicKey.findProgramAddressSync(
      [Buffer.from("market"), ev.pda.toBuffer(), nameBuf],
      program.programId
    );
    const [reserveVault] = PublicKey.findProgramAddressSync(
      [Buffer.from("reserve"), market.toBuffer()],
      program.programId
    );
    return { nameBuf, mintKp, market, reserveVault };
  };

  const initEvent = async (
    ev: Ev,
    p: { rounds: number; tax: number[]; seq: number[]; fee: number; vsol: bigint; vtok: bigint }
  ) => {
    await program.methods
      .initializeEvent(
        Array.from(ev.nameBuf),
        p.rounds,
        p.tax,
        p.seq,
        p.fee,
        new BN((7n * 86_400n).toString()),
        new BN(p.vsol.toString()),
        new BN(p.vtok.toString())
      )
      .accountsStrict({
        event: ev.pda,
        prizeVault: ev.prizeVault,
        authority: payer.publicKey,
        treasury,
        systemProgram: SystemProgram.programId,
      })
      .rpc();
    ev.rent0 = await balance(ev.prizeVault);
  };

  const createOutcome = (ev: Ev, o: Outcome) =>
    program.methods
      .createOutcome(Array.from(o.nameBuf))
      .accountsStrict({
        event: ev.pda,
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

  const buyCall = (ev: Ev, o: Outcome, user: Keypair, dx: bigint) =>
    program.methods
      .buy(new BN(dx.toString()), new BN(0))
      .accountsStrict({
        event: ev.pda,
        market: o.market,
        mint: o.mintKp.publicKey,
        reserveVault: o.reserveVault,
        prizeVault: ev.prizeVault,
        userTokenAccount: ata(o.mintKp.publicKey, user.publicKey),
        user: user.publicKey,
        tokenProgram: TOKEN_2022_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .preInstructions([
        uniquify(),
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

  const sellCall = (ev: Ev, o: Outcome, user: Keypair, dy: bigint) =>
    program.methods
      .sell(new BN(dy.toString()), new BN(0))
      .accountsStrict({
        event: ev.pda,
        market: o.market,
        mint: o.mintKp.publicKey,
        reserveVault: o.reserveVault,
        prizeVault: ev.prizeVault,
        userTokenAccount: ata(o.mintKp.publicKey, user.publicKey),
        user: user.publicKey,
        tokenProgram: TOKEN_2022_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .preInstructions([uniquify()])
      .signers([user])
      .rpc();

  const sequesterCall = (ev: Ev, o: Outcome) =>
    program.methods
      .sequester()
      .accountsStrict({
        event: ev.pda,
        market: o.market,
        reserveVault: o.reserveVault,
        prizeVault: ev.prizeVault,
      })
      .preInstructions([uniquify()])
      .rpc();

  const advanceCall = (ev: Ev) =>
    program.methods
      .advanceRound()
      .accountsStrict({ event: ev.pda, authority: payer.publicKey })
      .preInstructions([uniquify()])
      .rpc();

  /**
   * Assert chain state == mirror (P1) and invariants. `solvency` is checked
   * in the sane regime only: F3 documents how the bound exceeds the reserve
   * by a few lamports once the unit price crosses ~1 lamport.
   */
  const checkInvariants = async (
    ev: Ev,
    o: Outcome,
    m: Model,
    tag: string,
    opts: { solvency: boolean } = { solvency: true }
  ) => {
    const mk = await program.account.outcomeMarket.fetch(o.market);
    expect(mk.virtualSol.toString(), `${tag}: virtual_sol`).to.eq(m.vsol.toString());
    expect(mk.virtualTokens.toString(), `${tag}: virtual_tokens`).to.eq(m.vtok.toString());
    expect(mk.realReserve.toString(), `${tag}: real_reserve`).to.eq(m.reserve.toString());
    // P1 — lamport conservation, both vaults
    expect((await balance(o.reserveVault)).toString(), `${tag}: reserve vault`).to.eq(
      (ev.rent0 + m.reserve).toString()
    );
    expect((await balance(ev.prizeVault)).toString(), `${tag}: prize vault`).to.eq(
      (ev.rent0 + m.prize).toString()
    );
    // P3 — the curve can never be zeroed
    expect(m.vsol >= 1n, `${tag}: vsol ≥ 1`).to.be.true;
    expect(m.reserve >= 0n, `${tag}: reserve ≥ 0`).to.be.true;
    if (opts.solvency) {
      // P2 — the worst single exit fits in the reserve
      const bound = m.solvencyBound();
      expect(bound >= 0n, `${tag}: solvency bound non-negative`).to.be.true;
      expect(bound <= m.reserve, `${tag}: reserve covers full exit (${bound} ≤ ${m.reserve})`).to
        .be.true;
    }
  };

  before(async () => {
    const projectRoot = path.resolve(__dirname, "..");
    const MAX_SAFE = 9_000_000_000_000_000; // < 2^53, per-account genesis cap
    const fund = (pk: PublicKey) => ({
      address: pk,
      info: {
        lamports: MAX_SAFE,
        data: Buffer.alloc(0),
        owner: SystemProgram.programId,
        executable: false,
      },
    });
    context = await startAnchor(projectRoot, [], [
      ...traders.map((t) => fund(t.publicKey)),
      fund(whaleTax.publicKey),
      fund(whaleFee.publicKey),
      fund(small.publicKey),
      ...dummies.map((d) => fund(d.publicKey)),
    ]);
    provider = new BankrunProvider(context);
    program = new Program<Ephemere>(IDL, provider);
    payer = context.payer;
    [delegatePda] = PublicKey.findProgramAddressSync(
      [Buffer.from("delegate")],
      program.programId
    );

    // Whales need more than 2^53-1 lamports: aggregate from dummies
    // (genesis injection is JS-number-typed; transfers accept bigint).
    const topUp = new Transaction();
    topUp.add(
      SystemProgram.transfer({
        fromPubkey: dummies[0].publicKey,
        toPubkey: whaleTax.publicKey,
        lamports: 4_000_000_000_000_000n,
      }),
      SystemProgram.transfer({
        fromPubkey: dummies[1].publicKey,
        toPubkey: whaleFee.publicKey,
        lamports: 7_000_000_000_000_000n,
      }),
      SystemProgram.transfer({
        fromPubkey: dummies[2].publicKey,
        toPubkey: whaleFee.publicKey,
        lamports: 7_000_000_000_000_000n,
      })
    );
    topUp.recentBlockhash = context.lastBlockhash;
    topUp.feePayer = payer.publicKey;
    topUp.sign(payer, dummies[0], dummies[1], dummies[2]);
    await context.banksClient.processTransaction(topUp);
  });

  // ── P1/P2/P3 — the random walk ────────────────────────────────────────────
  const evF = { ev: null as unknown as Ev, o: null as unknown as Outcome };
  const walkModel = new Model(10n * BigInt(LAMPORTS_PER_SOL), 1_000_000_000_000_000n);
  const holdings = new Map<string, bigint>(); // trader → token balance (mirror)

  it(`random walk (${WALK_STEPS} ops, seed 0x${SEED.toString(16)}): fidelity, conservation, solvency at every step`, async function () {
    evF.ev = deriveEvent("FUZZ-WALK");
    await initEvent(evF.ev, {
      rounds: 16,
      tax: WALK_TAX,
      seq: WALK_SEQ,
      fee: 500,
      vsol: walkModel.vsol,
      vtok: walkModel.vtok,
    });
    evF.o = deriveOutcome(evF.ev, "FUZZ-O");
    await createOutcome(evF.ev, evF.o);
    traders.forEach((t) => holdings.set(t.publicKey.toBase58(), 0n));

    let round = 0;
    let dustSells = 0;

    for (let step = 0; step < WALK_STEPS; step++) {
      const dice = rand();
      const trader = traders[randInt(0, traders.length - 1)];
      const key = trader.publicKey.toBase58();

      if (dice < 0.6) {
        // BUY: log-uniform magnitude, 1 lamport … ~10 000 SOL
        const dx = BigInt(randInt(1, 999)) * 10n ** BigInt(randInt(0, 10));
        const quote = walkModel.quoteBuy(dx);
        if (quote === 0n) {
          // Price per unit exceeds dx: the program must refuse cleanly
          await expectFailAny(buyCall(evF.ev, evF.o, trader, dx), ["ZeroAmount"]);
        } else {
          const out = walkModel.buy(dx);
          await buyCall(evF.ev, evF.o, trader, dx);
          holdings.set(key, holdings.get(key)! + out);
        }
      } else if (dice < 0.95) {
        // SELL: random percentage of the trader's holdings (1–100%)
        const bal = holdings.get(key)!;
        if (bal === 0n) {
          step--; // nothing to sell — redraw
          continue;
        }
        const dy = (bal * BigInt(randInt(1, 100))) / 100n;
        if (dy === 0n) continue;
        const q = walkModel.sell(dy, BigInt(WALK_TAX[round]));
        if (q.gross === 0n) dustSells++; // dust: tokens burned, 0 lamports out
        await sellCall(evF.ev, evF.o, trader, dy);
        holdings.set(key, bal - dy);
      } else {
        // HOURGLASS: advance a round (if any left) and turn the crank
        if (round + 1 >= 16) {
          step--;
          continue;
        }
        await advanceCall(evF.ev);
        round++;
        walkModel.sequester(BigInt(WALK_SEQ[round]));
        await sequesterCall(evF.ev, evF.o);
      }

      await checkInvariants(evF.ev, evF.o, walkModel, `step ${step}`);
    }

    console.log(
      `      walk done: round ${round}, supply ${walkModel.supply}, ` +
        `reserve ${walkModel.reserve}, prize ${walkModel.prize}, ${dustSells} dust sells`
    );
  });

  it("full unwind: every holder exits completely, reserve never underflows", async () => {
    const ev = evF.ev;
    const o = evF.o;
    const round = (await program.account.eventState.fetch(ev.pda)).currentRound;

    for (const trader of traders) {
      const key = trader.publicKey.toBase58();
      const bal = holdings.get(key)!;
      if (bal === 0n) continue;
      const q = walkModel.sell(bal, BigInt(WALK_TAX[round]));
      expect(q.gross >= 0n).to.be.true;
      await sellCall(ev, o, trader, bal); // would throw InsufficientReserve if P2 broke
      holdings.set(key, 0n);
      await checkInvariants(ev, o, walkModel, `unwind ${key.slice(0, 8)}`);
    }

    expect(walkModel.supply).to.eq(0n);
    expect((await mintSupply(o.mintKp.publicKey)).toString()).to.eq("0");
    // What remains is the house dust from rounding — never negative
    expect(walkModel.reserve >= 0n).to.be.true;
    console.log(`      dust kept by the reserve after full exit: ${walkModel.reserve} lamports`);
  });

  // ── P4 — no round-trip profit (sane regime) ──────────────────────────────
  it("round-trip buy→sell never profits: rounding alone at 0 tax, strictly with tax", async () => {
    const ev = deriveEvent("FUZZ-RT");
    await initEvent(ev, {
      rounds: 2,
      tax: [0, 100, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], // round 0: PURE rounding
      seq: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
      fee: 0,
      vsol: 10n * BigInt(LAMPORTS_PER_SOL),
      vtok: 1_000_000_000_000_000n,
    });
    const o = deriveOutcome(ev, "RT-O");
    await createOutcome(ev, o);
    const m = new Model(10n * BigInt(LAMPORTS_PER_SOL), 1_000_000_000_000_000n);
    const t = traders[0];

    const amounts = [1n, 2n, 3n, 7n, 17n, 999n, 12_345n, 1_000_000n, 123_456_789n,
      1_000_000_000n, 12_340_000_000n, 1_000_000_000_000n, 9_999_999_999_999n];

    // Round 0 — tax is zero: the rounding alone must prevent profit
    for (const dx of amounts) {
      const out = m.buy(dx);
      expect(out > 0n).to.be.true;
      await buyCall(ev, o, t, dx);
      const q = m.sell(out, 0n);
      await sellCall(ev, o, t, out);
      expect(q.net <= dx, `round-trip of ${dx}: net ${q.net} must not exceed cost`).to.be.true;
      await checkInvariants(ev, o, m, `rt ${dx}`);
    }

    // Round 1 — 1% tax: strictly lossy
    await advanceCall(ev);
    for (const dx of [1_000_000n, 5_000_000_000n, 2_000_000_000_000n]) {
      const out = m.buy(dx);
      await buyCall(ev, o, t, dx);
      const q = m.sell(out, 100n);
      await sellCall(ev, o, t, out);
      expect(q.net < dx, `taxed round-trip of ${dx} must lose money`).to.be.true;
      await checkInvariants(ev, o, m, `rt-taxed ${dx}`);
    }

    // P5 extreme: dust sell on a deep curve — 0 lamports out, tokens burned.
    // Rounding against the trader by design; frontends should always set
    // min_lamports_out > 0.
    m.buy(1_000_000_000n);
    await buyCall(ev, o, t, 1_000_000_000n);
    const q = m.sell(1n, 100n);
    expect(q.gross).to.eq(0n);
    const before = await balance(t.publicKey);
    await sellCall(ev, o, t, 1n);
    expect(await balance(t.publicKey), "dust sell pays exactly 0").to.eq(before);
    await checkInvariants(ev, o, m, "dust sell");
  });

  // ── P3 probe — markdown floor on a minimal curve ──────────────────────────
  it("sequester markdown on a minimal curve floors correctly and never zeroes virtual_sol", async () => {
    const ev = deriveEvent("FUZZ-MIN");
    await initEvent(ev, {
      rounds: 2,
      tax: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
      seq: [0, 2500, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], // max-rate hourglass
      fee: 0,
      vsol: 1n, // smallest legal curve
      vtok: 1_000_000_000n,
    });
    const o = deriveOutcome(ev, "MIN-O");
    await createOutcome(ev, o);
    const m = new Model(1n, 1_000_000_000n);

    m.buy(16n);
    await buyCall(ev, o, traders[1], 16n); // vsol 17, reserve 16
    await advanceCall(ev);
    const amt = m.sequester(2500n); // floor(16·25%) = 4 out, vsol floor(17·75%) = 12
    expect(amt).to.eq(4n);
    expect(m.vsol).to.eq(12n);
    await sequesterCall(ev, o);
    await checkInvariants(ev, o, m, "min-curve sequester");
    // Note: on a degenerate curve like this one the (vsol − reserve) margin
    // erodes to 0 through markdown rounding — the InsufficientReserve guard
    // in sell() is what actually protects the vault. The markdown itself
    // can never zero virtual_sol while amount > 0 (vsol ≥ reserve ≥ 4 here
    // implies the 75% floor stays ≥ 1); max(1) remains defense in depth.
  });

  // ── F1 — sell-tax multiplication cliff (pins CURRENT behavior) ───────────
  it("FINDINGS F1: a sell with gross > u64::MAX/tax_bps panics (funds safe); smaller sells work", async function () {
    this.timeout(120_000);
    const ev = deriveEvent("FUZZ-HT");
    await initEvent(ev, {
      rounds: 1,
      tax: [2500, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], // max tax → lowest cliff
      seq: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
      fee: 0,
      vsol: 10n * BigInt(LAMPORTS_PER_SOL),
      vtok: 1_000_000_000_000_000n,
    });
    const o = deriveOutcome(ev, "HT-O");
    await createOutcome(ev, o);
    const m = new Model(10n * BigInt(LAMPORTS_PER_SOL), 1_000_000_000_000_000n);

    // 9M SOL in. The unit price is now ≈ 8M lamports — F3 territory: the
    // full-exit gross exceeds the reserve by a few lamports, so a sell-all
    // is blocked by InsufficientReserve (asserted at the end). A 95% exit
    // passes the reserve guard and hits the tax multiplication instead.
    const dx = 9_000_000_000_000_000n;
    const out = m.buy(dx);
    await buyCall(ev, o, whaleTax, dx);
    await checkInvariants(ev, o, m, "post whale buy", { solvency: false });

    // gross(95% of supply) ≈ 8.96e15 > u64::MAX/2500 ≈ 7.38e15:
    // `gross_out * tax_bps` overflows u64 → clean panic, tx aborts, nothing
    // moves. Documented in FINDINGS.md — never a silent wrap.
    const dy95 = (out * 95n) / 100n;
    expect(m.quoteSellGross(dy95) > 18_446_744_073_709_551_615n / 2500n).to.be.true;
    expect(m.quoteSellGross(dy95) <= m.reserve).to.be.true; // reserve guard passes
    await expectFailAny(sellCall(ev, o, whaleTax, dy95), [
      "overflow",
      "panicked",
      "failed to complete",
      "ProgramFailedToComplete",
    ]);
    await checkInvariants(ev, o, m, "post-panic state untouched", { solvency: false });

    // The trader is NOT stuck: a first sell sized under the cliff…
    const dy1 = 4_000_000_000n; // gross ≈ 7.04e15 < cliff
    expect(m.quoteSellGross(dy1) < 18_446_744_073_709_551_615n / 2500n).to.be.true;
    m.sell(dy1, 2500n);
    await sellCall(ev, o, whaleTax, dy1);
    await checkInvariants(ev, o, m, "first chunk", { solvency: false });

    // …then the rest. F3 corner: the exact-all exit may exceed the reserve
    // by a few lamports; the model decides, and if blocked the trader backs
    // off by a hair. Either way the vault never underflows.
    let rest = out - dy1;
    if (m.quoteSellGross(rest) > m.reserve) {
      await expectFailAny(
        sellCall(ev, o, whaleTax, rest),
        ["InsufficientReserve"]
      );
      while (m.quoteSellGross(rest) > m.reserve) rest -= 100_000_000_000n;
    }
    m.sell(rest, 2500n);
    await sellCall(ev, o, whaleTax, rest);
    await checkInvariants(ev, o, m, "whale exit complete", { solvency: false });
  });

  // ── F3 — round-trip profit corner at unit price > 1 lamport ──────────────
  it("FINDINGS F3: above ~1 lamport/unit, a round trip can profit a few lamports from others' reserve", async () => {
    const ev = deriveEvent("FUZZ-F3");
    await initEvent(ev, {
      rounds: 1,
      tax: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
      seq: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
      fee: 0,
      vsol: 10n * BigInt(LAMPORTS_PER_SOL),
      vtok: 1_000_000_000n, // tiny token side → unit price ≈ 10 lamports
    });
    const o = deriveOutcome(ev, "F3-O");
    await createOutcome(ev, o);
    const m = new Model(10n * BigInt(LAMPORTS_PER_SOL), 1_000_000_000n);

    // A victim deposits first — their reserve is what the dust-profit taps
    const victimIn = 100_000_000n;
    m.buy(victimIn);
    await buyCall(ev, o, traders[2], victimIn);

    // Deterministic search for a dx whose buy→sell-all round trip profits
    const found = (() => {
      for (let i = 0; i < 5000; i++) {
        const dx = 1_000_000_000n + BigInt(i);
        const probe = m.clone();
        const got = probe.buy(dx);
        const gross = probe.quoteSellGross(got); // tax is 0
        if (gross > dx && gross <= probe.reserve) return { dx, profit: gross - dx };
      }
      return null;
    })();
    expect(found, "a profitable round trip exists in this regime").to.not.be.null;
    const { dx, profit } = found!;

    const attacker = traders[3];
    const before = await balance(attacker.publicKey);
    const got = m.buy(dx);
    await buyCall(ev, o, attacker, dx);
    m.sell(got, 0n);
    await sellCall(ev, o, attacker, got);
    const after = await balance(attacker.publicKey);

    // The profit is real, exactly as modeled — and microscopic: bounded by
    // ~1 unit's price, dwarfed by the ~5000-lamport tx fee. The fix (or the
    // decision to keep the guard as-is) belongs to FINDINGS.md, not here.
    expect((after - before).toString(), "on-chain profit == modeled profit").to.eq(
      profit.toString()
    );
    expect(after - before > 0n, "round trip extracted a profit").to.be.true;
    expect(after - before < 50n, "profit is lamport-dust, not an economic drain").to.be.true;
    await checkInvariants(ev, o, m, "F3 aftermath", { solvency: false });
    console.log(`      F3: dx=${dx} profited ${profit} lamports (fee ≈ 5000 lamports)`);
  });

  // ── F2 — resolve-fee multiplication cliff (pins CURRENT behavior) ────────
  it("FINDINGS F2: resolve panics when pot × fee_bps exceeds u64 — resolve is not chunkable", async function () {
    this.timeout(120_000);
    const ev = deriveEvent("FUZZ-HF");
    await initEvent(ev, {
      rounds: 1,
      tax: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
      seq: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
      fee: 1000, // max fee → cliff at pot ≈ 18.4M SOL
      vsol: 10n * BigInt(LAMPORTS_PER_SOL),
      vtok: 1_000_000_000_000_000n,
    });
    const loser = deriveOutcome(ev, "HF-L");
    const winner = deriveOutcome(ev, "HF-W");
    await createOutcome(ev, loser);
    await createOutcome(ev, winner);

    // 20M SOL parked on the loser, someone holds the winner
    await buyCall(ev, loser, whaleFee, 20_000_000_000_000_000n);
    await buyCall(ev, winner, small, 1_000_000_000n);

    // Eliminate the loser: its whole reserve sweeps into the pot (no mult,
    // works at any size). Pot is now ≈ 2e16 > u64::MAX/1000 ≈ 1.84e16.
    await program.methods
      .eliminate()
      .accountsStrict({
        event: ev.pda,
        market: loser.market,
        reserveVault: loser.reserveVault,
        prizeVault: ev.prizeVault,
        authority: payer.publicKey,
      })
      .rpc();

    // `pot_total * protocol_fee_bps` overflows u64 → resolve panics. Unlike
    // a sell, resolve CANNOT be chunked: above this pot the event cannot be
    // resolved and redemption is unreachable. ~18.4M SOL is far beyond any
    // realistic event, but resolve is the one instruction that must never
    // brick — see FINDINGS.md F2 for the one-line u128 fix to decide on.
    await expectFailAny(
      program.methods
        .resolve()
        .accountsStrict({
          event: ev.pda,
          market: winner.market,
          mint: winner.mintKp.publicKey,
          reserveVault: winner.reserveVault,
          prizeVault: ev.prizeVault,
          treasury,
          authority: payer.publicKey,
        })
        .rpc(),
      ["overflow", "panicked", "failed to complete", "ProgramFailedToComplete"]
    );

    // Event still Active, pot intact — nothing was lost, nothing moved
    const evAcc = await program.account.eventState.fetch(ev.pda);
    expect(Object.keys(evAcc.status)[0]).to.eq("active");
  });
});
