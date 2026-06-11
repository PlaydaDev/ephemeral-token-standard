//! ═══════════════════════════════════════════════════════════════════════════
//!
//!   ÉPHÉMÈRE PROTOCOL — Ephemeral Token Standard (ETS) v0.1
//!   Built by Éphémère Labs — https://github.com/ephemere-labs
//!   License: MIT
//!
//!   "Every token here is born with a death date."
//!
//!   A generic, event-agnostic primitive for MORTAL OUTCOME TOKENS:
//!
//!     • An Event has N mutually-exclusive Outcomes (teams, candidates,
//!       players, anything). Exactly one Outcome wins.
//!     • Each Outcome gets its own freely-tradable token on its own native
//!       bonding curve (constant product, virtual reserves). Buying a token
//!       IS the bet. Selling IS the cash-out. Price IS the implied odds.
//!     • When an Outcome is eliminated, its token DIES: trading freezes
//!       forever, its entire SOL reserve is swept into a common, sealed
//!       PRIZE VAULT, and its supply can be burned by anyone (permanent
//!       delegate cleanup). Losers' liquidity becomes the winners' pot.
//!     • Each round, a scheduled slice of every surviving reserve is
//!       sequestered into the prize vault (the "hourglass"): value migrates
//!       deterministically from the markets to the pot as the event unfolds.
//!     • A round-scaled sell tax routes late exits into the prize vault:
//!       quitters fund believers.
//!     • At resolution, the winning token becomes a REDEMPTION TICKET:
//!       burn it, receive a fixed pro-rata share of the prize vault in SOL.
//!       After the claim window, every token of the event can be wiped from
//!       the chain. The event leaves no zombies behind.
//!
//!   WHAT THIS CONTRACT DOES **NOT** KNOW:
//!     Nothing about football, elections, esports or any sport. "Rounds",
//!     "eliminations" and "the winner" are reported by an ORACLE AUTHORITY
//!     configured at event creation. Integrators bring their own event
//!     logic off-chain and push state transitions on-chain. We strongly
//!     recommend a multisig (e.g. Squads) or an optimistic oracle as the
//!     authority — a single hot key makes YOU the trusted bookmaker.
//!
//!   TRUST MODEL / INVARIANTS (verify them — that's why this is open source):
//!     I1. SOL only ever leaves an outcome reserve via `sell` (at curve
//!         price, taxed) or toward the prize vault. There is NO path from
//!         any reserve to the authority or treasury.
//!     I2. The prize vault only ever pays out via `redeem` (winner holders,
//!         pro-rata, after resolution) and `sweep_unclaimed` (treasury,
//!         only after the claim window has fully elapsed).
//!     I3. The protocol fee is taken ONCE, at resolution, as a disclosed
//!         bps of the final pot. No other revenue path exists.
//!     I4. `eliminate`, `resolve`, `advance_round`, freeze/unfreeze are
//!         oracle-only. Everything else is permissionless.
//!     I5. The mass burn (`burn_residual`) is impossible while an outcome
//!         is alive and the event unresolved. The permanent delegate is a
//!         PDA — no private key exists that can sign for it.
//!     I6. Deploy with the upgrade authority BURNED (or behind a disclosed
//!         timelock). Otherwise none of the above means anything.
//!
//!   STATUS: spec-grade reference implementation. Compile, test on devnet
//!   with a full simulated event lifecycle, and get it audited before any
//!   mainnet deployment holding real funds.
//!
//! ═══════════════════════════════════════════════════════════════════════════

use anchor_lang::prelude::*;
use anchor_lang::solana_program::{program::invoke, system_instruction};
use anchor_spl::token_2022::spl_token_2022::{
    extension::ExtensionType,
    instruction as token_ix,
    state::Mint as Token2022Mint,
};
use anchor_spl::token_interface::{
    self, Burn, Mint, MintTo, Token2022, TokenAccount,
};

declare_id!("4UxnYz4N5b5MnvMeGNqYGyvcu3izQYC7m6df9RhYTygo");

pub const MAX_ROUNDS: usize = 16;
pub const BPS_DENOM: u64 = 10_000;
pub const NAME_LEN: usize = 32;

// ─────────────────────────────────────────────────────────────────────────────
// PROGRAM
// ─────────────────────────────────────────────────────────────────────────────

#[program]
pub mod ephemere {
    use super::*;

    /// Create a new ephemeral event.
    ///
    /// `sell_tax_bps[i]` / `sequester_bps[i]` apply during round `i`.
    /// All parameters are immutable after creation — participants can read
    /// the full economic schedule of the event before buying anything.
    pub fn initialize_event(
        ctx: Context<InitializeEvent>,
        name: [u8; NAME_LEN],
        num_rounds: u8,
        sell_tax_bps: [u16; MAX_ROUNDS],
        sequester_bps: [u16; MAX_ROUNDS],
        protocol_fee_bps: u16,
        claim_window_secs: i64,
        initial_virtual_sol: u64,
        initial_virtual_tokens: u64,
    ) -> Result<()> {
        require!(num_rounds as usize <= MAX_ROUNDS, EphemereError::BadConfig);
        require!(protocol_fee_bps <= 1_000, EphemereError::BadConfig); // ≤10%, hard cap
        require!(claim_window_secs >= 7 * 86_400, EphemereError::BadConfig); // ≥7 days
        require!(
            initial_virtual_sol > 0 && initial_virtual_tokens > 0,
            EphemereError::BadConfig
        );
        for i in 0..(num_rounds as usize) {
            require!(sell_tax_bps[i] as u64 <= 2_500, EphemereError::BadConfig); // ≤25%
            require!(sequester_bps[i] as u64 <= 2_500, EphemereError::BadConfig);
        }

        let ev = &mut ctx.accounts.event;
        ev.authority = ctx.accounts.authority.key();
        ev.treasury = ctx.accounts.treasury.key();
        ev.name = name;
        ev.status = EventStatus::Active;
        ev.current_round = 0;
        ev.num_rounds = num_rounds;
        ev.sell_tax_bps = sell_tax_bps;
        ev.sequester_bps = sequester_bps;
        ev.protocol_fee_bps = protocol_fee_bps;
        ev.claim_window_secs = claim_window_secs;
        ev.outcome_count = 0;
        ev.alive_count = 0;
        ev.winner = Pubkey::default();
        ev.resolved_at = 0;
        ev.prize_pool_snapshot = 0;
        ev.winner_supply_snapshot = 0;
        ev.initial_virtual_sol = initial_virtual_sol;
        ev.initial_virtual_tokens = initial_virtual_tokens;
        ev.bump = ctx.bumps.event;
        ev.prize_vault_bump = ctx.bumps.prize_vault;
        emit!(EventInitialized { event: ev.key(), name });
        Ok(())
    }

    /// Register one Outcome (one mortal token). Oracle-only, before any
    /// trading starts (round 0, event Active).
    ///
    /// The mint is a Token-2022 mint whose ONLY extension is
    /// PermanentDelegate, pointed at this program's delegate PDA — an
    /// address with no private key. Mint & freeze authority = market PDA.
    pub fn create_outcome(
        ctx: Context<CreateOutcome>,
        name: [u8; NAME_LEN],
    ) -> Result<()> {
        let ev = &mut ctx.accounts.event;
        require!(ev.status == EventStatus::Active, EphemereError::WrongState);
        require!(ev.current_round == 0, EphemereError::WrongState);
        require!(
            ctx.accounts.authority.key() == ev.authority,
            EphemereError::Unauthorized
        );

        // ── Manually create the Token-2022 mint with the PermanentDelegate
        //    extension (must be initialized BEFORE InitializeMint2).
        let space =
            ExtensionType::try_calculate_account_len::<Token2022Mint>(&[
                ExtensionType::PermanentDelegate,
            ])?;
        let rent = Rent::get()?.minimum_balance(space);
        invoke(
            &system_instruction::create_account(
                &ctx.accounts.authority.key(),
                &ctx.accounts.mint.key(),
                rent,
                space as u64,
                &ctx.accounts.token_program.key(),
            ),
            &[
                ctx.accounts.authority.to_account_info(),
                ctx.accounts.mint.to_account_info(),
            ],
        )?;
        invoke(
            &token_ix::initialize_permanent_delegate(
                &ctx.accounts.token_program.key(),
                &ctx.accounts.mint.key(),
                &ctx.accounts.delegate_pda.key(),
            )?,
            &[ctx.accounts.mint.to_account_info()],
        )?;
        invoke(
            &token_ix::initialize_mint2(
                &ctx.accounts.token_program.key(),
                &ctx.accounts.mint.key(),
                &ctx.accounts.market.key(), // mint authority = market PDA
                Some(&ctx.accounts.market.key()), // freeze authority
                9,
            )?,
            &[ctx.accounts.mint.to_account_info()],
        )?;

        let m = &mut ctx.accounts.market;
        m.event = ev.key();
        m.mint = ctx.accounts.mint.key();
        m.name = name;
        m.status = OutcomeStatus::Active;
        m.virtual_sol = ev.initial_virtual_sol;
        m.virtual_tokens = ev.initial_virtual_tokens;
        m.real_reserve = 0;
        m.last_sequestered_round = 0;
        m.bump = ctx.bumps.market;
        m.reserve_bump = ctx.bumps.reserve_vault;

        ev.outcome_count += 1;
        ev.alive_count += 1;
        emit!(OutcomeCreated { event: ev.key(), market: m.key(), name });
        Ok(())
    }

    /// Buy outcome tokens with SOL at curve price. Permissionless.
    /// Buying IS betting on this outcome.
    pub fn buy(ctx: Context<Trade>, lamports_in: u64, min_tokens_out: u64) -> Result<()> {
        let ev = &ctx.accounts.event;
        let m = &mut ctx.accounts.market;
        require!(ev.status == EventStatus::Active, EphemereError::WrongState);
        require!(m.status == OutcomeStatus::Active, EphemereError::OutcomeNotTradable);
        require!(lamports_in > 0, EphemereError::ZeroAmount);

        // Constant product on virtual reserves: dy = y - k/(x + dx)
        let k = (m.virtual_sol as u128) * (m.virtual_tokens as u128);
        let new_vsol = (m.virtual_sol as u128) + (lamports_in as u128);
        let new_vtok = k / new_vsol; // floor → rounds AGAINST the buyer (safe)
        let tokens_out = (m.virtual_tokens as u128 - new_vtok) as u64;
        require!(tokens_out >= min_tokens_out, EphemereError::Slippage);
        require!(tokens_out > 0, EphemereError::ZeroAmount);

        // SOL: user → reserve vault (system transfer, user signs)
        invoke(
            &system_instruction::transfer(
                &ctx.accounts.user.key(),
                &ctx.accounts.reserve_vault.key(),
                lamports_in,
            ),
            &[
                ctx.accounts.user.to_account_info(),
                ctx.accounts.reserve_vault.to_account_info(),
            ],
        )?;

        // Tokens: minted to user, market PDA signs
        let ev_key = ev.key();
        let seeds: &[&[u8]] = &[b"market", ev_key.as_ref(), m.name.as_ref(), &[m.bump]];
        token_interface::mint_to(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                MintTo {
                    mint: ctx.accounts.mint.to_account_info(),
                    to: ctx.accounts.user_token_account.to_account_info(),
                    authority: m.to_account_info(),
                },
                &[seeds],
            ),
            tokens_out,
        )?;

        m.virtual_sol = new_vsol as u64;
        m.virtual_tokens = new_vtok as u64;
        m.real_reserve = m.real_reserve.checked_add(lamports_in).unwrap();
        emit!(Trade2 { market: m.key(), is_buy: true, lamports: lamports_in, tokens: tokens_out });
        Ok(())
    }

    /// Sell outcome tokens back to the curve. Permissionless.
    /// The round-scaled sell tax is routed to the prize vault (I1):
    /// late quitters fund the eventual winners.
    pub fn sell(ctx: Context<Trade>, tokens_in: u64, min_lamports_out: u64) -> Result<()> {
        let ev = &ctx.accounts.event;
        let m = &mut ctx.accounts.market;
        require!(ev.status == EventStatus::Active, EphemereError::WrongState);
        require!(m.status == OutcomeStatus::Active, EphemereError::OutcomeNotTradable);
        require!(tokens_in > 0, EphemereError::ZeroAmount);

        let k = (m.virtual_sol as u128) * (m.virtual_tokens as u128);
        let new_vtok = (m.virtual_tokens as u128) + (tokens_in as u128);
        let new_vsol = k / new_vtok + 1; // ceil → rounds AGAINST the seller (safe)
        let gross_out = (m.virtual_sol as u128 - new_vsol) as u64;
        require!(gross_out <= m.real_reserve, EphemereError::InsufficientReserve);

        let tax_bps = ev.sell_tax_bps[ev.current_round as usize] as u64;
        // u128: the bps product of a u64 amount can exceed u64 — the result
        // is ≤ gross_out, so the cast back is lossless (FINDINGS F1).
        let tax = ((gross_out as u128) * (tax_bps as u128) / BPS_DENOM as u128) as u64;
        let net_out = gross_out - tax;
        require!(net_out >= min_lamports_out, EphemereError::Slippage);

        // Burn the seller's tokens (user signs their own burn)
        token_interface::burn(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Burn {
                    mint: ctx.accounts.mint.to_account_info(),
                    from: ctx.accounts.user_token_account.to_account_info(),
                    authority: ctx.accounts.user.to_account_info(),
                },
            ),
            tokens_in,
        )?;

        // Lamports out of the program-owned reserve vault
        debit(&ctx.accounts.reserve_vault, gross_out)?;
        credit(&ctx.accounts.user.to_account_info(), net_out)?;
        credit(&ctx.accounts.prize_vault, tax)?;

        m.virtual_sol = new_vsol as u64;
        m.virtual_tokens = new_vtok as u64;
        m.real_reserve -= gross_out;
        emit!(Trade2 { market: m.key(), is_buy: false, lamports: net_out, tokens: tokens_in });
        Ok(())
    }

    /// Oracle: advance the event to the next round (changes the active tax
    /// and sequestration rates per the immutable schedule).
    pub fn advance_round(ctx: Context<OracleEvent>) -> Result<()> {
        let ev = &mut ctx.accounts.event;
        require!(ev.status == EventStatus::Active, EphemereError::WrongState);
        require!(ev.current_round + 1 < ev.num_rounds, EphemereError::BadConfig);
        ev.current_round += 1;
        emit!(RoundAdvanced { event: ev.key(), round: ev.current_round });
        Ok(())
    }

    /// Permissionless crank: apply the current round's sequestration to one
    /// surviving market — move `sequester_bps` of its real reserve into the
    /// prize vault and mark the curve down proportionally. The hourglass.
    /// Callable once per market per round, by anyone.
    pub fn sequester(ctx: Context<Sequester>) -> Result<()> {
        let ev = &ctx.accounts.event;
        let m = &mut ctx.accounts.market;
        require!(ev.status == EventStatus::Active, EphemereError::WrongState);
        require!(m.status == OutcomeStatus::Active || m.status == OutcomeStatus::Frozen,
                 EphemereError::OutcomeNotTradable);
        require!(m.last_sequestered_round < ev.current_round, EphemereError::AlreadySequestered);

        let bps = ev.sequester_bps[ev.current_round as usize] as u128;
        let amount = ((m.real_reserve as u128) * bps / BPS_DENOM as u128) as u64;

        if amount > 0 {
            debit(&ctx.accounts.reserve_vault, amount)?;
            credit(&ctx.accounts.prize_vault, amount)?;
            // Deterministic markdown: virtual SOL shrinks by the same ratio
            // so the curve price reflects the migrated value. Known in
            // advance by everyone — a feature, not a rug.
            let new_vsol =
                (m.virtual_sol as u128) * (BPS_DENOM as u128 - bps) / BPS_DENOM as u128;
            m.virtual_sol = new_vsol.max(1) as u64;
            m.real_reserve -= amount;
        }
        m.last_sequestered_round = ev.current_round;
        emit!(Sequestered { market: m.key(), round: ev.current_round, lamports: amount });
        Ok(())
    }

    /// Oracle: freeze/unfreeze trading on one outcome (e.g. while its match
    /// is being played — every bookmaker closes bets at kickoff).
    pub fn set_freeze(ctx: Context<OracleMarket>, frozen: bool) -> Result<()> {
        let m = &mut ctx.accounts.market;
        match (frozen, m.status) {
            (true, OutcomeStatus::Active) => m.status = OutcomeStatus::Frozen,
            (false, OutcomeStatus::Frozen) => m.status = OutcomeStatus::Active,
            _ => return err!(EphemereError::WrongState),
        }
        Ok(())
    }

    /// Oracle: THE OUTCOME IS DEAD. Its token dies with it.
    /// Trading freezes forever; the ENTIRE remaining reserve is swept into
    /// the prize vault. The losers' liquidity becomes the winners' pot.
    pub fn eliminate(ctx: Context<OracleMarketWithVaults>) -> Result<()> {
        let ev = &mut ctx.accounts.event;
        let m = &mut ctx.accounts.market;
        require!(ev.status == EventStatus::Active, EphemereError::WrongState);
        require!(
            m.status == OutcomeStatus::Active || m.status == OutcomeStatus::Frozen,
            EphemereError::WrongState
        );

        let swept = m.real_reserve;
        if swept > 0 {
            debit(&ctx.accounts.reserve_vault, swept)?;
            credit(&ctx.accounts.prize_vault, swept)?;
        }
        m.real_reserve = 0;
        m.status = OutcomeStatus::Eliminated;
        ev.alive_count -= 1;
        emit!(Eliminated { market: m.key(), swept_lamports: swept });
        Ok(())
    }

    /// Oracle: resolve the event. Exactly one Active/Frozen outcome must
    /// remain — it is the winner. Its own residual reserve joins the pot,
    /// the protocol fee is taken (ONCE, I3), and the redemption rate is
    /// frozen via snapshots. From here the winning token is a ticket:
    /// burn it via `redeem`, get SOL.
    pub fn resolve(ctx: Context<Resolve>) -> Result<()> {
        let ev = &mut ctx.accounts.event;
        let m = &mut ctx.accounts.market;
        require!(ev.status == EventStatus::Active, EphemereError::WrongState);
        require!(
            m.status == OutcomeStatus::Active || m.status == OutcomeStatus::Frozen,
            EphemereError::WrongState
        );
        // The winner must be the LAST one standing — forces the oracle to
        // have explicitly eliminated every other outcome first.
        require!(ev.alive_count == 1, EphemereError::OutcomesStillAlive);

        // Winner's own residual reserve → pot
        let residual = m.real_reserve;
        if residual > 0 {
            debit(&ctx.accounts.reserve_vault, residual)?;
            credit(&ctx.accounts.prize_vault, residual)?;
        }
        m.real_reserve = 0;
        m.status = OutcomeStatus::Winner;

        // Protocol fee: once, on the final pot, to the treasury (I3)
        let rent_floor = Rent::get()?.minimum_balance(0);
        let pot_total = ctx
            .accounts
            .prize_vault
            .lamports()
            .saturating_sub(rent_floor);
        // u128: resolve is the one instruction that must never brick — the
        // bps product of a u64 pot can exceed u64 (FINDINGS F2); the result
        // is ≤ pot_total, so the cast back is lossless.
        let fee =
            ((pot_total as u128) * (ev.protocol_fee_bps as u128) / BPS_DENOM as u128) as u64;
        if fee > 0 {
            debit(&ctx.accounts.prize_vault, fee)?;
            credit(&ctx.accounts.treasury, fee)?;
        }

        // Freeze redemption math forever
        ev.status = EventStatus::Resolved;
        ev.winner = m.key();
        ev.resolved_at = Clock::get()?.unix_timestamp;
        ev.prize_pool_snapshot = pot_total - fee;
        ev.winner_supply_snapshot = ctx.accounts.mint.supply;
        require!(ev.winner_supply_snapshot > 0, EphemereError::ZeroAmount);

        emit!(Resolved {
            event: ev.key(),
            winner: m.key(),
            pot: ev.prize_pool_snapshot,
            winner_supply: ev.winner_supply_snapshot,
        });
        Ok(())
    }

    /// Winner holders: burn winning tokens, receive a pro-rata share of the
    /// pot at the frozen snapshot rate. Open during the claim window only.
    pub fn redeem(ctx: Context<Redeem>, tokens_in: u64) -> Result<()> {
        let ev = &ctx.accounts.event;
        let m = &ctx.accounts.market;
        require!(ev.status == EventStatus::Resolved, EphemereError::WrongState);
        require!(m.key() == ev.winner, EphemereError::NotTheWinner);
        require!(tokens_in > 0, EphemereError::ZeroAmount);
        let now = Clock::get()?.unix_timestamp;
        require!(
            now <= ev.resolved_at + ev.claim_window_secs,
            EphemereError::ClaimWindowClosed
        );

        // payout = tokens_in × pot_snapshot / supply_snapshot  (floor)
        let payout = ((tokens_in as u128) * (ev.prize_pool_snapshot as u128)
            / (ev.winner_supply_snapshot as u128)) as u64;

        token_interface::burn(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Burn {
                    mint: ctx.accounts.mint.to_account_info(),
                    from: ctx.accounts.user_token_account.to_account_info(),
                    authority: ctx.accounts.user.to_account_info(),
                },
            ),
            tokens_in,
        )?;
        debit(&ctx.accounts.prize_vault, payout)?;
        credit(&ctx.accounts.user.to_account_info(), payout)?;
        emit!(Redeemed { user: ctx.accounts.user.key(), tokens: tokens_in, lamports: payout });
        Ok(())
    }

    /// Permissionless cleanup: burn the residual supply of a DEAD token
    /// from ANY token account, via the permanent-delegate PDA. Gated hard:
    /// only for Eliminated outcomes, or any outcome once the event is
    /// Resolved and the claim window has closed (I5). This is how the
    /// event leaves zero zombies on-chain.
    pub fn burn_residual(ctx: Context<BurnResidual>) -> Result<()> {
        let ev = &ctx.accounts.event;
        let m = &ctx.accounts.market;
        let now = Clock::get()?.unix_timestamp;
        let claim_over = ev.status == EventStatus::Resolved
            && now > ev.resolved_at + ev.claim_window_secs;
        require!(
            m.status == OutcomeStatus::Eliminated || claim_over,
            EphemereError::TokenStillAlive
        );

        let amount = ctx.accounts.target_token_account.amount;
        require!(amount > 0, EphemereError::ZeroAmount);
        let seeds: &[&[u8]] = &[b"delegate", &[ctx.bumps.delegate_pda]];
        token_interface::burn(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Burn {
                    mint: ctx.accounts.mint.to_account_info(),
                    from: ctx.accounts.target_token_account.to_account_info(),
                    authority: ctx.accounts.delegate_pda.to_account_info(),
                },
                &[seeds],
            ),
            amount,
        )?;
        Ok(())
    }

    /// After the claim window: whatever remains in the prize vault goes to
    /// the treasury (e.g. seeds the next Éphémère event). Terminal state.
    pub fn sweep_unclaimed(ctx: Context<Sweep>) -> Result<()> {
        let ev = &mut ctx.accounts.event;
        require!(ev.status == EventStatus::Resolved, EphemereError::WrongState);
        let now = Clock::get()?.unix_timestamp;
        require!(
            now > ev.resolved_at + ev.claim_window_secs,
            EphemereError::ClaimWindowStillOpen
        );
        let rent_floor = Rent::get()?.minimum_balance(0);
        let rest = ctx.accounts.prize_vault.lamports().saturating_sub(rent_floor);
        if rest > 0 {
            debit(&ctx.accounts.prize_vault, rest)?;
            credit(&ctx.accounts.treasury, rest)?;
        }
        ev.status = EventStatus::Swept;
        emit!(Swept2 { event: ev.key(), lamports: rest });
        Ok(())
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// LAMPORT HELPERS (program-owned vaults)
// ─────────────────────────────────────────────────────────────────────────────

fn debit(vault: &AccountInfo, amount: u64) -> Result<()> {
    **vault.try_borrow_mut_lamports()? = vault
        .lamports()
        .checked_sub(amount)
        .ok_or(EphemereError::InsufficientReserve)?;
    Ok(())
}
fn credit(to: &AccountInfo, amount: u64) -> Result<()> {
    **to.try_borrow_mut_lamports()? =
        to.lamports().checked_add(amount).unwrap();
    Ok(())
}

// ─────────────────────────────────────────────────────────────────────────────
// STATE
// ─────────────────────────────────────────────────────────────────────────────

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq)]
pub enum EventStatus { Active, Resolved, Swept }

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq)]
pub enum OutcomeStatus { Active, Frozen, Eliminated, Winner }

#[account]
pub struct EventState {
    pub authority: Pubkey,          // oracle — USE A MULTISIG
    pub treasury: Pubkey,
    pub name: [u8; NAME_LEN],
    pub status: EventStatus,
    pub current_round: u8,
    pub num_rounds: u8,
    pub sell_tax_bps: [u16; MAX_ROUNDS],
    pub sequester_bps: [u16; MAX_ROUNDS],
    pub protocol_fee_bps: u16,
    pub claim_window_secs: i64,
    pub outcome_count: u16,
    pub alive_count: u16,
    pub winner: Pubkey,
    pub resolved_at: i64,
    pub prize_pool_snapshot: u64,
    pub winner_supply_snapshot: u64,
    pub initial_virtual_sol: u64,
    pub initial_virtual_tokens: u64,
    pub bump: u8,
    pub prize_vault_bump: u8,
}
impl EventState { pub const SIZE: usize = 8 + 32*3 + NAME_LEN + 1 + 1 + 1 + 2*MAX_ROUNDS*2 + 2 + 8 + 2 + 2 + 8 + 8 + 8 + 8 + 8 + 1 + 1; }

#[account]
pub struct OutcomeMarket {
    pub event: Pubkey,
    pub mint: Pubkey,
    pub name: [u8; NAME_LEN],
    pub status: OutcomeStatus,
    pub virtual_sol: u64,
    pub virtual_tokens: u64,
    pub real_reserve: u64,
    pub last_sequestered_round: u8,
    pub bump: u8,
    pub reserve_bump: u8,
}
impl OutcomeMarket { pub const SIZE: usize = 8 + 32 + 32 + NAME_LEN + 1 + 8 + 8 + 8 + 1 + 1 + 1; }

// ─────────────────────────────────────────────────────────────────────────────
// ACCOUNTS
// ─────────────────────────────────────────────────────────────────────────────

#[derive(Accounts)]
#[instruction(name: [u8; NAME_LEN])]
pub struct InitializeEvent<'info> {
    #[account(init, payer = authority, space = EventState::SIZE,
              seeds = [b"event", name.as_ref()], bump)]
    pub event: Account<'info, EventState>,
    /// CHECK: program-owned lamport vault, zero data
    #[account(init, payer = authority, space = 0, owner = crate::ID,
              seeds = [b"prize", event.key().as_ref()], bump)]
    pub prize_vault: AccountInfo<'info>,
    #[account(mut)]
    pub authority: Signer<'info>,
    /// CHECK: fee destination, configured once, immutable
    pub treasury: AccountInfo<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(name: [u8; NAME_LEN])]
pub struct CreateOutcome<'info> {
    #[account(mut)]
    pub event: Account<'info, EventState>,
    #[account(init, payer = authority, space = OutcomeMarket::SIZE,
              seeds = [b"market", event.key().as_ref(), name.as_ref()], bump)]
    pub market: Account<'info, OutcomeMarket>,
    /// CHECK: created + initialized manually with PermanentDelegate ext.
    #[account(mut)]
    pub mint: Signer<'info>,
    /// CHECK: program-owned lamport vault, zero data
    #[account(init, payer = authority, space = 0, owner = crate::ID,
              seeds = [b"reserve", market.key().as_ref()], bump)]
    pub reserve_vault: AccountInfo<'info>,
    /// CHECK: PDA with no data; permanent delegate of every Éphémère mint
    #[account(seeds = [b"delegate"], bump)]
    pub delegate_pda: AccountInfo<'info>,
    #[account(mut)]
    pub authority: Signer<'info>,
    pub token_program: Program<'info, Token2022>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Trade<'info> {
    pub event: Account<'info, EventState>,
    #[account(mut, has_one = event, has_one = mint)]
    pub market: Account<'info, OutcomeMarket>,
    #[account(mut)]
    pub mint: InterfaceAccount<'info, Mint>,
    /// CHECK: PDA vault
    #[account(mut, seeds = [b"reserve", market.key().as_ref()], bump = market.reserve_bump)]
    pub reserve_vault: AccountInfo<'info>,
    /// CHECK: PDA vault
    #[account(mut, seeds = [b"prize", event.key().as_ref()], bump = event.prize_vault_bump)]
    pub prize_vault: AccountInfo<'info>,
    #[account(mut, token::mint = mint, token::authority = user)]
    pub user_token_account: InterfaceAccount<'info, TokenAccount>,
    #[account(mut)]
    pub user: Signer<'info>,
    pub token_program: Program<'info, Token2022>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct OracleEvent<'info> {
    #[account(mut, has_one = authority @ EphemereError::Unauthorized)]
    pub event: Account<'info, EventState>,
    pub authority: Signer<'info>,
}

#[derive(Accounts)]
pub struct OracleMarket<'info> {
    #[account(has_one = authority @ EphemereError::Unauthorized)]
    pub event: Account<'info, EventState>,
    #[account(mut, has_one = event)]
    pub market: Account<'info, OutcomeMarket>,
    pub authority: Signer<'info>,
}

#[derive(Accounts)]
pub struct OracleMarketWithVaults<'info> {
    #[account(mut, has_one = authority @ EphemereError::Unauthorized)]
    pub event: Account<'info, EventState>,
    #[account(mut, has_one = event)]
    pub market: Account<'info, OutcomeMarket>,
    /// CHECK: PDA vault
    #[account(mut, seeds = [b"reserve", market.key().as_ref()], bump = market.reserve_bump)]
    pub reserve_vault: AccountInfo<'info>,
    /// CHECK: PDA vault
    #[account(mut, seeds = [b"prize", event.key().as_ref()], bump = event.prize_vault_bump)]
    pub prize_vault: AccountInfo<'info>,
    pub authority: Signer<'info>,
}

#[derive(Accounts)]
pub struct Sequester<'info> {
    pub event: Account<'info, EventState>,
    #[account(mut, has_one = event)]
    pub market: Account<'info, OutcomeMarket>,
    /// CHECK: PDA vault
    #[account(mut, seeds = [b"reserve", market.key().as_ref()], bump = market.reserve_bump)]
    pub reserve_vault: AccountInfo<'info>,
    /// CHECK: PDA vault
    #[account(mut, seeds = [b"prize", event.key().as_ref()], bump = event.prize_vault_bump)]
    pub prize_vault: AccountInfo<'info>,
}

#[derive(Accounts)]
pub struct Resolve<'info> {
    #[account(mut, has_one = authority @ EphemereError::Unauthorized)]
    pub event: Account<'info, EventState>,
    #[account(mut, has_one = event, has_one = mint)]
    pub market: Account<'info, OutcomeMarket>,
    pub mint: InterfaceAccount<'info, Mint>,
    /// CHECK: PDA vault
    #[account(mut, seeds = [b"reserve", market.key().as_ref()], bump = market.reserve_bump)]
    pub reserve_vault: AccountInfo<'info>,
    /// CHECK: PDA vault
    #[account(mut, seeds = [b"prize", event.key().as_ref()], bump = event.prize_vault_bump)]
    pub prize_vault: AccountInfo<'info>,
    /// CHECK: must match event.treasury
    #[account(mut, address = event.treasury @ EphemereError::Unauthorized)]
    pub treasury: AccountInfo<'info>,
    pub authority: Signer<'info>,
}

#[derive(Accounts)]
pub struct Redeem<'info> {
    pub event: Account<'info, EventState>,
    #[account(has_one = event, has_one = mint)]
    pub market: Account<'info, OutcomeMarket>,
    #[account(mut)]
    pub mint: InterfaceAccount<'info, Mint>,
    /// CHECK: PDA vault
    #[account(mut, seeds = [b"prize", event.key().as_ref()], bump = event.prize_vault_bump)]
    pub prize_vault: AccountInfo<'info>,
    #[account(mut, token::mint = mint, token::authority = user)]
    pub user_token_account: InterfaceAccount<'info, TokenAccount>,
    #[account(mut)]
    pub user: Signer<'info>,
    pub token_program: Program<'info, Token2022>,
}

#[derive(Accounts)]
pub struct BurnResidual<'info> {
    pub event: Account<'info, EventState>,
    #[account(has_one = event, has_one = mint)]
    pub market: Account<'info, OutcomeMarket>,
    #[account(mut)]
    pub mint: InterfaceAccount<'info, Mint>,
    /// Any token account of this mint — cleanup is permissionless.
    #[account(mut, token::mint = mint)]
    pub target_token_account: InterfaceAccount<'info, TokenAccount>,
    /// CHECK: permanent delegate PDA, no data, no key
    #[account(seeds = [b"delegate"], bump)]
    pub delegate_pda: AccountInfo<'info>,
    pub token_program: Program<'info, Token2022>,
}

#[derive(Accounts)]
pub struct Sweep<'info> {
    #[account(mut)]
    pub event: Account<'info, EventState>,
    /// CHECK: PDA vault
    #[account(mut, seeds = [b"prize", event.key().as_ref()], bump = event.prize_vault_bump)]
    pub prize_vault: AccountInfo<'info>,
    /// CHECK: must match event.treasury
    #[account(mut, address = event.treasury @ EphemereError::Unauthorized)]
    pub treasury: AccountInfo<'info>,
}

// ─────────────────────────────────────────────────────────────────────────────
// EVENTS & ERRORS
// ─────────────────────────────────────────────────────────────────────────────

#[event] pub struct EventInitialized { pub event: Pubkey, pub name: [u8; NAME_LEN] }
#[event] pub struct OutcomeCreated { pub event: Pubkey, pub market: Pubkey, pub name: [u8; NAME_LEN] }
#[event] pub struct Trade2 { pub market: Pubkey, pub is_buy: bool, pub lamports: u64, pub tokens: u64 }
#[event] pub struct RoundAdvanced { pub event: Pubkey, pub round: u8 }
#[event] pub struct Sequestered { pub market: Pubkey, pub round: u8, pub lamports: u64 }
#[event] pub struct Eliminated { pub market: Pubkey, pub swept_lamports: u64 }
#[event] pub struct Resolved { pub event: Pubkey, pub winner: Pubkey, pub pot: u64, pub winner_supply: u64 }
#[event] pub struct Redeemed { pub user: Pubkey, pub tokens: u64, pub lamports: u64 }
#[event] pub struct Swept2 { pub event: Pubkey, pub lamports: u64 }

#[error_code]
pub enum EphemereError {
    #[msg("Invalid configuration")] BadConfig,
    #[msg("Unauthorized: oracle authority required")] Unauthorized,
    #[msg("Wrong event/outcome state for this instruction")] WrongState,
    #[msg("This outcome is not tradable")] OutcomeNotTradable,
    #[msg("Slippage limit exceeded")] Slippage,
    #[msg("Amount must be greater than zero")] ZeroAmount,
    #[msg("Insufficient reserve")] InsufficientReserve,
    #[msg("Already sequestered for this round")] AlreadySequestered,
    #[msg("More than one outcome still alive — eliminate them first")] OutcomesStillAlive,
    #[msg("Not the winning outcome")] NotTheWinner,
    #[msg("Claim window closed")] ClaimWindowClosed,
    #[msg("Claim window still open")] ClaimWindowStillOpen,
    #[msg("Token still alive — mass burn is locked")] TokenStillAlive,
}
