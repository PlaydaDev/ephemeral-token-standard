/**
 * Mission 5 — Devnet end-to-end demo.
 *
 * Deploys nothing itself: expects the program already deployed at the
 * declare_id (scripts/devnet-deploy.sh). Creates a fresh DEMO event
 * (unique name per run), drives the full death cycle with real devnet
 * transactions, and writes every signature into DEVNET_PROOF.md with
 * explorer links — the public proof that mortal tokens die as designed.
 *
 * What cannot be demonstrated same-day: the claim window has a hard 7-day
 * floor (BadConfig guard, immutable by design), so `sweep_unclaimed` and
 * `burn_residual` on the WINNER are only callable 7 days after resolve.
 * The proof documents both gates firing (clean rejections at preflight).
 *
 * Run (WSL): npx tsx scripts/devnet_demo.ts
 */
import * as anchor from "@coral-xyz/anchor";
import { AnchorProvider, BN, Program, Wallet } from "@coral-xyz/anchor";
import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
} from "@solana/web3.js";
import {
  TOKEN_2022_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
  unpackAccount,
  unpackMint,
} from "@solana/spl-token";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { Ephemere } from "../target/types/ephemere";

const IDL = require("../target/idl/ephemere.json");

const RPC = process.env.RPC_URL ?? "https://api.devnet.solana.com";
const CLAIM_WINDOW = 7n * 86_400n;
const INIT_VSOL = 1_000_000_000n; // 1 SOL virtual depth
const INIT_VTOK = 1_000_000_000_000_000n; // 1M tokens @9dp — sub-lamport unit price (FINDINGS F3)
const SELL_TAX = [100, 500, 1000, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
const SEQ_BPS = [0, 200, 300, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];

const name32 = (s: string): Buffer => {
  const b = Buffer.alloc(32);
  b.write(s, "utf8");
  return b;
};

const link = (sig: string) => `https://explorer.solana.com/tx/${sig}?cluster=devnet`;
const addrLink = (a: PublicKey) =>
  `https://explorer.solana.com/address/${a.toBase58()}?cluster=devnet`;

interface ProofLine {
  step: string;
  sig?: string;
  note?: string;
}
const proof: ProofLine[] = [];
const log = (step: string, sig?: string, note?: string) => {
  console.log(`  ✔ ${step}${sig ? `  ${sig.slice(0, 16)}…` : ""}${note ? `  (${note})` : ""}`);
  proof.push({ step, sig, note });
};

async function main() {
  const wallet = new Wallet(
    Keypair.fromSecretKey(
      Uint8Array.from(
        JSON.parse(fs.readFileSync(path.join(os.homedir(), ".config/solana/id.json"), "utf8"))
      )
    )
  );
  const connection = new Connection(RPC, "confirmed");
  const provider = new AnchorProvider(connection, wallet, { commitment: "confirmed" });
  const program = new Program<Ephemere>(IDL, provider);
  const me = wallet.publicKey;
  const treasury = me; // demo treasury = deployer wallet, disclosed in the proof

  console.log(`program  ${program.programId.toBase58()}`);
  console.log(`wallet   ${me.toBase58()}`);
  console.log(`balance  ${(await connection.getBalance(me)) / LAMPORTS_PER_SOL} SOL`);

  // Unique event name per run (event PDA is seeded by name)
  const runTag = Date.now().toString(36).toUpperCase();
  const EVENT_NAME = name32(`DEMO-${runTag}`);
  const [eventPda] = PublicKey.findProgramAddressSync(
    [Buffer.from("event"), EVENT_NAME],
    program.programId
  );
  const [prizeVault] = PublicKey.findProgramAddressSync(
    [Buffer.from("prize"), eventPda.toBuffer()],
    program.programId
  );
  const [delegatePda] = PublicKey.findProgramAddressSync(
    [Buffer.from("delegate")],
    program.programId
  );
  console.log(`event    DEMO-${runTag} → ${eventPda.toBase58()}`);

  interface Outcome {
    label: string;
    nameBuf: Buffer;
    mintKp: Keypair;
    market: PublicKey;
    reserveVault: PublicKey;
    ata: PublicKey;
  }
  const outcomes: Outcome[] = ["ALPHA", "BRAVO", "CHARLIE", "DELTA"].map((label) => {
    const nameBuf = name32(label);
    const mintKp = Keypair.generate();
    const [market] = PublicKey.findProgramAddressSync(
      [Buffer.from("market"), eventPda.toBuffer(), nameBuf],
      program.programId
    );
    const [reserveVault] = PublicKey.findProgramAddressSync(
      [Buffer.from("reserve"), market.toBuffer()],
      program.programId
    );
    return {
      label,
      nameBuf,
      mintKp,
      market,
      reserveVault,
      ata: getAssociatedTokenAddressSync(mintKp.publicKey, me, false, TOKEN_2022_PROGRAM_ID),
    };
  });
  const [A, B, C, D] = outcomes;

  const tokenBalance = async (ataAddr: PublicKey): Promise<bigint> => {
    const ai = await connection.getAccountInfo(ataAddr);
    if (!ai) return 0n;
    return unpackAccount(ataAddr, ai, TOKEN_2022_PROGRAM_ID).amount;
  };
  const supplyOf = async (mint: PublicKey): Promise<bigint> => {
    const ai = await connection.getAccountInfo(mint);
    return unpackMint(mint, ai, TOKEN_2022_PROGRAM_ID).supply;
  };

  const expectRejected = async (step: string, p: Promise<unknown>, code: string) => {
    try {
      await p;
      throw new Error(`GATE FAILED OPEN: ${step} should have been rejected with ${code}`);
    } catch (e: any) {
      const s = `${e}` + JSON.stringify(e.logs ?? []);
      if (!s.includes(code)) throw e;
      log(`${step} → rejected with ${code}`, undefined, "gate holds; preflight rejection, no on-chain tx");
    }
  };

  // ── 1. initialize_event ───────────────────────────────────────────────────
  let sig = await program.methods
    .initializeEvent(
      Array.from(EVENT_NAME),
      3,
      SELL_TAX,
      SEQ_BPS,
      500,
      new BN(CLAIM_WINDOW.toString()),
      new BN(INIT_VSOL.toString()),
      new BN(INIT_VTOK.toString())
    )
    .accountsStrict({
      event: eventPda,
      prizeVault,
      authority: me,
      treasury,
      systemProgram: SystemProgram.programId,
    })
    .rpc();
  log("initialize_event (3 rounds, tax 1/5/10%, seq 0/2/3%, fee 5%, window 7d)", sig);

  // ── 2. create_outcome ×4 ──────────────────────────────────────────────────
  for (const o of outcomes) {
    sig = await program.methods
      .createOutcome(Array.from(o.nameBuf))
      .accountsStrict({
        event: eventPda,
        market: o.market,
        mint: o.mintKp.publicKey,
        reserveVault: o.reserveVault,
        delegatePda,
        authority: me,
        tokenProgram: TOKEN_2022_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([o.mintKp])
      .rpc();
    log(`create_outcome ${o.label} (mint ${o.mintKp.publicKey.toBase58().slice(0, 8)}…, PermanentDelegate = delegate PDA)`, sig);
  }

  // ── 3. buys ───────────────────────────────────────────────────────────────
  const buy = async (o: Outcome, lamports: bigint) => {
    const s = await program.methods
      .buy(new BN(lamports.toString()), new BN(0))
      .accountsStrict({
        event: eventPda,
        market: o.market,
        mint: o.mintKp.publicKey,
        reserveVault: o.reserveVault,
        prizeVault,
        userTokenAccount: o.ata,
        user: me,
        tokenProgram: TOKEN_2022_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .preInstructions([
        createAssociatedTokenAccountIdempotentInstruction(
          me,
          o.ata,
          me,
          o.mintKp.publicKey,
          TOKEN_2022_PROGRAM_ID
        ),
      ])
      .rpc();
    const got = await tokenBalance(o.ata);
    log(`buy ${Number(lamports) / LAMPORTS_PER_SOL} SOL of ${o.label} → ${got} units`, s);
    return s;
  };
  await buy(A, 50_000_000n);
  await buy(B, 30_000_000n);
  await buy(C, 20_000_000n);

  // ── 4. partial sell on B (taxed, tax → prize vault) ───────────────────────
  const bBal = await tokenBalance(B.ata);
  sig = await program.methods
    .sell(new BN((bBal / 2n).toString()), new BN(0))
    .accountsStrict({
      event: eventPda,
      market: B.market,
      mint: B.mintKp.publicKey,
      reserveVault: B.reserveVault,
      prizeVault,
      userTokenAccount: B.ata,
      user: me,
      tokenProgram: TOKEN_2022_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    })
    .rpc();
  log(`sell half of BRAVO position (round-0 tax 1% → prize vault)`, sig);

  // ── 5. freeze / unfreeze (bookmaker closes bets at kickoff) ───────────────
  sig = await program.methods
    .setFreeze(true)
    .accountsStrict({ event: eventPda, market: C.market, authority: me })
    .rpc();
  log("set_freeze CHARLIE = true", sig);
  await expectRejected(
    "buy on frozen CHARLIE",
    program.methods
      .buy(new BN(10_000_000), new BN(0))
      .accountsStrict({
        event: eventPda,
        market: C.market,
        mint: C.mintKp.publicKey,
        reserveVault: C.reserveVault,
        prizeVault,
        userTokenAccount: C.ata,
        user: me,
        tokenProgram: TOKEN_2022_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .rpc(),
    "OutcomeNotTradable"
  );
  sig = await program.methods
    .setFreeze(false)
    .accountsStrict({ event: eventPda, market: C.market, authority: me })
    .rpc();
  log("set_freeze CHARLIE = false", sig);

  // ── 6. the hourglass: advance_round + public sequester crank ─────────────
  sig = await program.methods
    .advanceRound()
    .accountsStrict({ event: eventPda, authority: me })
    .rpc();
  log("advance_round → round 1 (sequester 2%, sell tax 5%)", sig);
  for (const o of outcomes) {
    sig = await program.methods
      .sequester()
      .accountsStrict({
        event: eventPda,
        market: o.market,
        reserveVault: o.reserveVault,
        prizeVault,
      })
      .rpc();
    log(`sequester ${o.label} (permissionless crank, 2% of reserve → pot, curve marked down)`, sig);
  }

  // ── 7. deaths: eliminate, sweep reserves, mass-burn the dead ─────────────
  const eliminate = async (o: Outcome) => {
    const reserve = (await program.account.outcomeMarket.fetch(o.market)).realReserve;
    const s = await program.methods
      .eliminate()
      .accountsStrict({
        event: eventPda,
        market: o.market,
        reserveVault: o.reserveVault,
        prizeVault,
        authority: me,
      })
      .rpc();
    log(`eliminate ${o.label} — ${reserve.toString()} lamports of reserve swept to the pot`, s);
  };
  await eliminate(D); // empty reserve — death still works
  await eliminate(C);
  await eliminate(B);

  // Dead tokens are erasable by ANYONE, immediately (I5):
  for (const o of [B, C]) {
    sig = await program.methods
      .burnResidual()
      .accountsStrict({
        event: eventPda,
        market: o.market,
        mint: o.mintKp.publicKey,
        targetTokenAccount: o.ata,
        delegatePda,
        tokenProgram: TOKEN_2022_PROGRAM_ID,
      })
      .rpc();
    log(
      `burn_residual ${o.label} — dead supply erased via keyless permanent-delegate PDA, supply now ${await supplyOf(o.mintKp.publicKey)}`,
      sig
    );
  }

  await expectRejected(
    "buy on eliminated CHARLIE",
    program.methods
      .buy(new BN(10_000_001), new BN(0))
      .accountsStrict({
        event: eventPda,
        market: C.market,
        mint: C.mintKp.publicKey,
        reserveVault: C.reserveVault,
        prizeVault,
        userTokenAccount: C.ata,
        user: me,
        tokenProgram: TOKEN_2022_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .rpc(),
    "OutcomeNotTradable"
  );

  // ── 8. resolve: last one standing wins ────────────────────────────────────
  const potBefore = await connection.getBalance(prizeVault);
  sig = await program.methods
    .resolve()
    .accountsStrict({
      event: eventPda,
      market: A.market,
      mint: A.mintKp.publicKey,
      reserveVault: A.reserveVault,
      prizeVault,
      treasury,
      authority: me,
    })
    .rpc();
  const ev = await program.account.eventState.fetch(eventPda);
  log(
    `resolve → ALPHA wins. Pot snapshot ${ev.prizePoolSnapshot.toString()} lamports, ` +
      `winner supply snapshot ${ev.winnerSupplySnapshot.toString()}, fee 5% → treasury`,
    sig
  );

  // ── 9. redeem: the winning token is now a ticket ──────────────────────────
  const aBal = await tokenBalance(A.ata);
  const half = aBal / 2n;
  const expectedPayout =
    (half * BigInt(ev.prizePoolSnapshot.toString())) / BigInt(ev.winnerSupplySnapshot.toString());
  sig = await program.methods
    .redeem(new BN(half.toString()))
    .accountsStrict({
      event: eventPda,
      market: A.market,
      mint: A.mintKp.publicKey,
      prizeVault,
      userTokenAccount: A.ata,
      user: me,
      tokenProgram: TOKEN_2022_PROGRAM_ID,
    })
    .rpc();
  log(
    `redeem ${half} ALPHA units → ${expectedPayout} lamports (burn-for-SOL at the frozen pro-rata rate)`,
    sig
  );

  // ── 10. the 7-day gates hold (provable again on-chain after the window) ──
  await expectRejected(
    "sweep_unclaimed before the window closes",
    program.methods
      .sweepUnclaimed()
      .accountsStrict({ event: eventPda, prizeVault, treasury })
      .rpc(),
    "ClaimWindowStillOpen"
  );
  await expectRejected(
    "burn_residual on the WINNER during the claim window",
    program.methods
      .burnResidual()
      .accountsStrict({
        event: eventPda,
        market: A.market,
        mint: A.mintKp.publicKey,
        targetTokenAccount: A.ata,
        delegatePda,
        tokenProgram: TOKEN_2022_PROGRAM_ID,
      })
      .rpc(),
    "TokenStillAlive"
  );

  // ── Final state ───────────────────────────────────────────────────────────
  const final = {
    event: eventPda.toBase58(),
    status: Object.keys((await program.account.eventState.fetch(eventPda)).status)[0],
    potRemaining: await connection.getBalance(prizeVault),
    supplies: {} as Record<string, string>,
  };
  for (const o of outcomes) final.supplies[o.label] = (await supplyOf(o.mintKp.publicKey)).toString();

  // ── Write DEVNET_PROOF.md ─────────────────────────────────────────────────
  const md: string[] = [];
  md.push(`# DEVNET_PROOF.md — Éphémère Protocol, full death-cycle on devnet`);
  md.push(``);
  md.push(`Every signature below is a real devnet transaction, verifiable on the explorer.`);
  md.push(``);
  md.push(`| | |`);
  md.push(`|---|---|`);
  md.push(`| Program | [\`${program.programId.toBase58()}\`](${addrLink(program.programId)}) |`);
  md.push(`| Deployer / oracle / demo treasury | [\`${me.toBase58()}\`](${addrLink(me)}) |`);
  md.push(`| Event | \`DEMO-${runTag}\` → [\`${eventPda.toBase58()}\`](${addrLink(eventPda)}) |`);
  md.push(`| Prize vault | [\`${prizeVault.toBase58()}\`](${addrLink(prizeVault)}) |`);
  md.push(`| Outcomes | ${outcomes.map((o) => `${o.label} [\`${o.mintKp.publicKey.toBase58().slice(0, 8)}…\`](${addrLink(o.mintKp.publicKey)})`).join(" · ")} |`);
  md.push(``);
  md.push(`Event parameters (immutable since creation): 3 rounds, sell tax 1/5/10%, sequestration 0/2/3%, protocol fee 5%, claim window 7 days, curve 1 SOL × 1M tokens virtual.`);
  md.push(``);
  md.push(`## Transaction log`);
  md.push(``);
  for (const p of proof) {
    if (p.sig) md.push(`- ${p.step}\\\n  [\`${p.sig}\`](${link(p.sig)})`);
    else md.push(`- ${p.step}${p.note ? ` — *${p.note}*` : ""}`);
  }
  md.push(``);
  md.push(`## Final state`);
  md.push(``);
  md.push(`- Event status: \`${final.status}\` (Resolved — claim window open for 7 days)`);
  md.push(`- Residual supplies: ${Object.entries(final.supplies).map(([k, v]) => `${k} = ${v}`).join(", ")}`);
  md.push(`  - BRAVO/CHARLIE were erased by \`burn_residual\` (anyone can bury a dead token); DELTA never minted; ALPHA keeps the unredeemed half until the window closes.`);
  md.push(``);
  md.push(`## What the 7-day claim window intentionally defers`);
  md.push(``);
  md.push(`The contract enforces \`claim_window_secs ≥ 7 days\` at creation (BadConfig guard —`);
  md.push(`the trust promise cannot be configured away, even for demos). Therefore two final`);
  md.push(`steps can only be executed ≥ 7 days after \`resolve\`, and their gates were instead`);
  md.push(`proven to hold above (clean preflight rejections):`);
  md.push(``);
  md.push(`1. \`burn_residual\` on the WINNER (rejected with \`TokenStillAlive\` during the window)`);
  md.push(`2. \`sweep_unclaimed\` (rejected with \`ClaimWindowStillOpen\`)`);
  md.push(``);
  md.push(`Both rejections are also covered by the bankrun test suites with full clock control`);
  md.push(`(34 green tests: lifecycle, adversarial, curve fuzz — see \`tests/\`).`);
  md.push(``);
  fs.writeFileSync(path.resolve(__dirname, "../DEVNET_PROOF.md"), md.join("\n"));
  console.log(`\nDEVNET_PROOF.md written (${proof.length} steps).`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
