// Token Radar scoring model.
// Takes a sealed snapshot of pre-token protocols, scores each,
// and produces a ranked board plus a live-token comparison set.
//
// The model is pure math: no protocol name is special-cased.
// Every row runs through the same function.
//
// ---- implied value ----
//
//   base       = tvl_usd * BASE_MULTIPLE
//   tvlMult    = protocols below TVL_RELEVANCE_FLOOR get sqrt(tvl / floor)
//   growth     = clamp(change_7d, GROWTH_FLOOR, GROWTH_CAP) percent
//   growthMult = positive: 1 + sqrt(growth/cap)*(cap/100)*WEIGHT_UP
//                negative: 1 + (growth/100)*WEIGHT_DOWN
//                clamped at GROWTH_MULT_FLOOR
//   maturity   = bell curve rising from MATURITY_FLOOR to 1.0 at PEAK_DAYS,
//                then decaying to DECAY_FLOOR over DECAY_DAYS
//   freshness  = bonus for protocols listed within FRESHNESS_DAYS
//   chainMult  = 1 + min(chains-1, CHAIN_MAX) * CHAIN_BONUS
//   catWeight  = category multiplier (default 1.0)
//   implied    = max(1, round(base * tvlMult * growthMult * maturity * chainMult * catWeight))

/** One protocol as the sealed snapshot carries it: exactly ten fields. */
export interface SnapshotProtocol {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

/** The sealed snapshot document. */
export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: SnapshotProtocol[];
  watchlist: string[];
}

/** The house model's constants — stated in the dashboard, changeable in the sandbox. */
export interface ModelConstants {
  base_multiple: number;
  growth_weight_up: number;
  growth_weight_down: number;
  growth_floor: number;
  growth_cap: number;
  growth_mult_floor: number;
  maturity_floor: number;
  maturity_peak_days: number;
  maturity_decay_days: number;
  maturity_decay_floor: number;
  unknown_age_days: number;
  freshness_days: number;
  freshness_bonus: number;
  tvl_relevance_floor: number;
  chain_bonus: number;
  chain_max: number;
  category_weights: Record<string, number>;
}

/** The house model's tuned constants. */
export const MODEL: ModelConstants = {
  base_multiple: 0.25,
  growth_weight_up: 0.40,
  growth_weight_down: 0.75,
  growth_floor: -60,
  growth_cap: 120,
  growth_mult_floor: 0.40,
  maturity_floor: 0.55,
  maturity_peak_days: 365,
  maturity_decay_days: 1460,
  maturity_decay_floor: 0.50,
  unknown_age_days: 365,
  freshness_days: 90,
  freshness_bonus: 0.10,
  tvl_relevance_floor: 10_000,
  chain_bonus: 0.08,
  chain_max: 5,
  category_weights: {
    'Lending': 1.15,
    'CDP': 1.15,
    'Leveraged Farming': 1.10,
    'Yield': 1.10,
    'Yield Aggregator': 1.05,
    'Dexes': 1.00,
    'Derivatives': 1.00,
    'Bridge': 0.90,
    'Staking': 0.90,
    'Restaking': 0.95,
    'Services': 0.85,
    'Prediction Market': 0.85,
    'Stablecoin': 0.80,
    'RWA': 1.10,
    'Insurance': 0.75,
  },
};

/** The model's version label, shown in the dashboard. */
export const MODEL_VERSION = 'radar-2';

/** How many pre-token protocols below the watchlist floor the early radar carries. */
export const EARLY_ROWS = 160;

/** How many live-token protocols the Live view carries. */
export const LIVE_ROWS = 24;

// ---- types for the board and dashboard ----

/** A single farm step: what to do, what it costs, how long it takes. */
export interface FarmStep {
  text: string;
  cost: string;
  time: string;
}

/** One row of board.json — the ranked board. */
export interface BoardRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
  token_status: 'pre-token';
  age_days: number | null;
  implied_value_usd: number;
  model: {
    base_multiple: number;
    growth_pct: number;
    growth_multiplier: number;
    maturity_multiplier: number;
    age_days: number | null;
  };
  farm_steps: string[];
}

/** Compact row for the dashboard's data.js — no farm steps (the page generates them). */
export interface RadarRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  age_days: number | null;
  implied_value_usd: number;
  growth_multiplier: number;
  maturity_multiplier: number;
}

/** A live-token protocol: already trades, value is the market's own number. */
export interface LiveRow {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  mcap_usd: number | null;
  change_7d: number | null;
}

/** Everything the dashboard renders. */
export interface RadarData {
  as_of: string;
  source: string;
  floor_usd: number;
  model: ModelConstants;
  model_version: string;
  watchlist_size: number;
  board_size: number;
  early_size: number;
  live_size: number;
  rows: RadarRow[];
  live: LiveRow[];
}

// ---- errors ----

/** Why the snapshot is not one this model can score. */
export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotError';
  }
}

// ---- helpers ----

const DAY_MS = 86_400_000;

/** A finite number, else the fallback. */
function finite(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** Round to 4 decimal places. */
const round4 = (n: number): number => Math.round(n * 1e4) / 1e4;

// ---- age ----

/** Whole days from listed_at to as_of, or null when either date is absent or unparseable. */
export function ageDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const a = Date.parse(`${asOf}T00:00:00Z`);
  const b = Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, Math.floor((a - b) / DAY_MS));
}

// ---- implied value: the model's core ----

/**
 * Compute one protocol's implied value and the multipliers that produced it.
 * Returns the value in USD, the clamped growth percentage, the growth multiplier,
 * the maturity multiplier, and the protocol's age in days.
 */
export function impliedValue(
  protocol: SnapshotProtocol,
  asOf: string,
  model: ModelConstants,
): { implied: number; growthPct: number; growthMult: number; maturityMult: number; age: number | null } {
  const age = ageDays(asOf, protocol.listed_at);

  // ---- growth multiplier (asymmetric: losses hurt harder) ----
  const rawGrowth = finite(protocol.change_7d, 0);
  const growthPct = Math.min(model.growth_cap, Math.max(model.growth_floor, rawGrowth));

  let growthMult: number;
  if (growthPct >= 0) {
    // Positive growth gets sqrt damping to avoid runaway scores.
    const dampened = Math.sqrt(growthPct / model.growth_cap) * (model.growth_cap / 100);
    growthMult = 1 + dampened * model.growth_weight_up;
  } else {
    // Negative growth hits harder: weight_down > weight_up.
    growthMult = 1 + (growthPct / 100) * model.growth_weight_down;
  }
  growthMult = Math.max(growthMult, model.growth_mult_floor);

  // ---- maturity multiplier (bell curve) ----
  const ageForModel = age ?? model.unknown_age_days;

  let maturityMult: number;
  if (ageForModel <= model.maturity_peak_days) {
    // Ascending: floor → 1.0 as protocol approaches peak.
    const t = ageForModel / model.maturity_peak_days;
    maturityMult = model.maturity_floor + (1.0 - model.maturity_floor) * t;
  } else {
    // Descending: 1.0 → decay_floor for protocols past peak without a token.
    const excess = ageForModel - model.maturity_peak_days;
    const t = Math.min(excess / model.maturity_decay_days, 1.0);
    maturityMult = 1.0 - (1.0 - model.maturity_decay_floor) * t;
  }

  // Freshness bonus: recently listed protocols get a small bump.
  if (age !== null && age >= 0 && age <= model.freshness_days) {
    maturityMult = Math.min(maturityMult + model.freshness_bonus, 1.1);
  }

  // ---- TVL relevance penalty ----
  // Tiny protocols get sqrt(tvl / floor) so they don't outrank
  // large ones on growth alone.
  let tvlMult = 1.0;
  if (protocol.tvl_usd < model.tvl_relevance_floor) {
    tvlMult = Math.sqrt(protocol.tvl_usd / model.tvl_relevance_floor);
  }

  // ---- chain diversity bonus ----
  const extraChains = Math.min(Math.max(protocol.chains.length - 1, 0), model.chain_max);
  const chainMult = 1 + extraChains * model.chain_bonus;

  // ---- category weight ----
  const catWeight = model.category_weights[protocol.category ?? ''] ?? 1.0;

  // ---- assemble ----
  const base = protocol.tvl_usd * model.base_multiple;
  const implied = Math.max(1, Math.round(base * tvlMult * growthMult * maturityMult * chainMult * catWeight));

  return { implied, growthPct: growthPct, growthMult, maturityMult, age };
}

// ---- protocol classification ----

/** A versioned pool name: ends in a release number like " V3", " v2", " 1.0". */
const VERSIONED = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;

/** Whether a protocol records no token. */
export function isPreToken(p: SnapshotProtocol): boolean {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}

/** Whether a protocol is rankable: pre-token, not a CEX, not a versioned pool. */
export function isRankable(p: SnapshotProtocol): boolean {
  return isPreToken(p) && p.category !== 'CEX' && !VERSIONED.test(p.name);
}

// ---- board building ----

/** Build a slug-to-protocol index from an array. */
function bySlug(protocols: SnapshotProtocol[]): Map<string, SnapshotProtocol> {
  return new Map(protocols.map((p) => [p.slug, p]));
}

/** Build the ranked board from a snapshot.
 *
 *  Every watchlist slug that appears in the snapshot goes on the board.
 *  Then the early radar fills in up to EARLY_ROWS pre-token protocols
 *  below the watchlist floor, sorted by TVL descending.
 *  All rows are scored with impliedValue and ranked strongest first.
 */
export function buildBoard(snapshot: Snapshot, model: ModelConstants = MODEL): BoardRow[] {
  const index = bySlug(snapshot.protocols);
  const chosen = new Map<string, SnapshotProtocol>();

  // Watchlist floor: every slug, even if missing from snapshot.
  for (const slug of snapshot.watchlist) {
    const p = index.get(slug);
    if (p !== undefined) chosen.set(slug, p);
  }

  // Early radar: pre-token protocols below the floor, by TVL.
  const early = snapshot.protocols
    .filter((p) => !chosen.has(p.slug) && isRankable(p) && p.tvl_usd < snapshot.floor_usd)
    .sort((a, b) => b.tvl_usd - a.tvl_usd || (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0))
    .slice(0, EARLY_ROWS);
  for (const p of early) chosen.set(p.slug, p);

  // Score all chosen protocols.
  const scored = [...chosen.values()].map((p) => {
    const { implied, growthPct, growthMult, maturityMult, age } = impliedValue(p, snapshot.as_of, model);
    return { p, implied, growthPct, growthMult, maturityMult, age };
  });

  // Sort: highest implied value first, tiebreak by slug.
  scored.sort((a, b) => b.implied - a.implied || (a.p.slug < b.p.slug ? -1 : a.p.slug > b.p.slug ? 1 : 0));

  // Build rows with ranks.
  return scored.map((s, i) => ({
    rank: i + 1,
    slug: s.p.slug,
    name: s.p.name,
    category: s.p.category,
    chains: s.p.chains,
    tvl_usd: s.p.tvl_usd,
    change_7d: s.p.change_7d,
    mcap_usd: s.p.mcap_usd,
    listed_at: s.p.listed_at,
    gecko_id: s.p.gecko_id,
    symbol: s.p.symbol,
    token_status: 'pre-token',
    age_days: s.age,
    implied_value_usd: s.implied,
    model: {
      base_multiple: model.base_multiple,
      growth_pct: s.growthPct,
      growth_multiplier: round4(s.growthMult),
      maturity_multiplier: round4(s.maturityMult),
      age_days: s.age,
    },
    farm_steps: farmSteps(s.p, s.age).map(stepText),
  }));
}

// ---- farm steps ----

/** Format a farm step to one string: the action, its cost, and its time. */
export function stepText(step: FarmStep): string {
  let s = `${step.text} Cost: ${step.cost}. Time: ${step.time}.`;
  if (s.length > 600) s = `${s.slice(0, 596)}...`;
  if (s.length < 20) s = `${s} Hold the position and check the protocol's own page.`;
  return s;
}

/** The first chain a protocol lists, or a neutral phrase. */
function chainOf(p: SnapshotProtocol): string {
  return p.chains.length > 0 ? p.chains[0]! : 'its main chain';
}

/** Capital for one farm position, derived from the protocol's TVL tier. */
function capitalFor(p: SnapshotProtocol): number {
  if (p.tvl_usd >= 5_000_000_000) return 250;
  if (p.tvl_usd >= 1_000_000_000) return 150;
  if (p.tvl_usd >= 100_000_000) return 100;
  return 50;
}

/** How many days to hold, based on protocol age. */
function holdDaysFor(age: number | null): number {
  if (age === null) return 30;
  if (age < 180) return 60;
  if (age < 365) return 45;
  return 30;
}

/** The category's one farming action. */
function actionFor(p: SnapshotProtocol, capital: number, chain: string): string {
  const c = (p.category ?? '').toLowerCase();
  const name = p.name;
  if (c.includes('lend') || c.includes('cdp') || c.includes('collateral'))
    return `Supply $${capital} of USDC to ${name} on ${chain} and keep the position open.`;
  if (c.includes('dex') || c.includes('yield') || c.includes('leveraged farm'))
    return `Provide $${capital} of liquidity to ${name}'s main pool on ${chain} and keep the position open.`;
  if (c.includes('bridge'))
    return `Bridge $${capital} of USDC to ${chain} through ${name} and use the bridged funds in its app.`;
  if (c.includes('staking') || c.includes('restak'))
    return `Stake $${capital} of the chain's staking asset through ${name} and keep the receipt.`;
  if (c.includes('perpetual') || c.includes('derivative'))
    return `Deposit $${capital} of USDC as margin on ${name} and open one small hedge.`;
  if (c.includes('prediction'))
    return `Fund $${capital} and place one market position on ${name}.`;
  if (c.includes('curator') || c.includes('allocator'))
    return `Deposit $${capital} into a ${name} vault on ${chain} and keep the shares.`;
  if (c.includes('stable'))
    return `Mint or deposit $${capital} of the stable asset through ${name} on ${chain}.`;
  if (c.includes('rwa'))
    return `Mint $${capital} of the protocol's yield asset on ${chain} and hold it.`;
  if (c.includes('insurance'))
    return `Buy $${capital} of cover from ${name} on ${chain} and keep the policy.`;
  return `Deposit $${capital} of USDC into ${name} on ${chain} and keep the position open.`;
}

/**
 * Every protocol gets the same six-step farm plan, derived from its
 * own record (category, chains, TVL, age) — never from a name list.
 */
export function farmSteps(p: SnapshotProtocol, age: number | null): FarmStep[] {
  const chain = chainOf(p);
  const capital = capitalFor(p);
  const hold = holdDaysFor(age);
  const action = actionFor(p, capital, chain);
  return [
    {
      text: `Use a fresh wallet that holds only the funds you plan to farm, and keep its seed phrase offline.`,
      cost: 'under $3 of gas for the first transaction',
      time: '5 minutes',
    },
    {
      text: action,
      cost: `$${capital} of capital and about $${capital >= 150 ? 8 : 4} of gas`,
      time: '15 minutes to set up',
    },
    {
      text: `Make one qualifying action each week, such as a deposit, a borrow, a swap or a vote.`,
      cost: 'about $2 of gas a week',
      time: '10 minutes a week',
    },
    {
      text: `Hold the position for at least ${hold} days so the activity is counted in more than one snapshot.`,
      cost: `the $${capital} stays in the position`,
      time: `${hold} days`,
    },
    {
      text: `Before you withdraw, open the protocol's own points or rewards page and claim only from the link it publishes.`,
      cost: 'no fee to check, and never pay to claim',
      time: '10 minutes',
    },
    {
      text: `Write the wallet, the dates and every transaction in a farm log so you can repeat the position or unwind it.`,
      cost: 'nothing but the log',
      time: '5 minutes',
    },
  ];
}

// ---- live tokens ----

/** The live-token protocols, by market cap, for the dashboard's Live token view. */
export function liveRows(snapshot: Snapshot): LiveRow[] {
  return snapshot.protocols
    .filter((p) => !isPreToken(p) && p.category !== 'CEX')
    .sort((a, b) => (b.mcap_usd ?? 0) - (a.mcap_usd ?? 0) || b.tvl_usd - a.tvl_usd)
    .slice(0, LIVE_ROWS)
    .map((p) => ({
      slug: p.slug,
      name: p.name,
      category: p.category,
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      mcap_usd: p.mcap_usd,
      change_7d: p.change_7d,
    }));
}

// ---- radar assembly ----

/** Compact a BoardRow into a RadarRow for the dashboard. */
export function radarRow(row: BoardRow): RadarRow {
  return {
    rank: row.rank,
    slug: row.slug,
    name: row.name,
    category: row.category,
    chains: row.chains,
    tvl_usd: row.tvl_usd,
    change_7d: row.change_7d,
    mcap_usd: row.mcap_usd,
    listed_at: row.listed_at,
    age_days: row.age_days,
    implied_value_usd: row.implied_value_usd,
    growth_multiplier: row.model.growth_multiplier,
    maturity_multiplier: row.model.maturity_multiplier,
  };
}

/** Build the full radar: ranked board + live set + dashboard data. */
export function buildRadar(
  snapshot: Snapshot,
  model: ModelConstants = MODEL,
): { board: BoardRow[]; radar: RadarData } {
  const board = buildBoard(snapshot, model);
  const live = liveRows(snapshot);
  const earlyCount = board.filter((r) => !snapshot.watchlist.includes(r.slug)).length;

  const radar: RadarData = {
    as_of: snapshot.as_of,
    source: snapshot.source,
    floor_usd: snapshot.floor_usd,
    model,
    model_version: MODEL_VERSION,
    watchlist_size: snapshot.watchlist.length,
    board_size: board.length,
    early_size: earlyCount,
    live_size: live.length,
    rows: board.map(radarRow),
    live,
  };

  return { board, radar };
}

// ---- snapshot parsing ----

/** Parse and validate the sealed snapshot JSON. */
export function parseSnapshot(text: string): Snapshot {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SnapshotError('snapshot.json is not JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw))
    throw new SnapshotError('snapshot.json is not a JSON object');

  const o = raw as Record<string, unknown>;
  if (typeof o.as_of !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(o.as_of))
    throw new SnapshotError('snapshot.json has no as_of date');
  if (typeof o.source !== 'string')
    throw new SnapshotError('snapshot.json has no source');
  if (typeof o.floor_usd !== 'number' || !Number.isSafeInteger(o.floor_usd) || o.floor_usd <= 0)
    throw new SnapshotError('snapshot.json has no floor_usd');
  if (!Array.isArray(o.protocols))
    throw new SnapshotError('snapshot.json has no protocols array');
  if (!Array.isArray(o.watchlist) || o.watchlist.some((s) => typeof s !== 'string'))
    throw new SnapshotError('snapshot.json has no watchlist of slugs');

  const protocols = o.protocols.map((v, i) => {
    if (typeof v !== 'object' || v === null || Array.isArray(v))
      throw new SnapshotError(`snapshot.json's protocol ${i} is not an object`);
    const p = v as Record<string, unknown>;
    if (
      typeof p.slug !== 'string' ||
      typeof p.name !== 'string' ||
      typeof p.tvl_usd !== 'number' ||
      !Number.isFinite(p.tvl_usd)
    ) {
      throw new SnapshotError(`snapshot.json's protocol ${i} lacks a slug, a name or a TVL`);
    }
    return {
      slug: p.slug,
      name: p.name,
      category: typeof p.category === 'string' ? p.category : null,
      chains: Array.isArray(p.chains)
        ? p.chains.filter((c): c is string => typeof c === 'string')
        : [],
      tvl_usd: p.tvl_usd,
      change_7d:
        typeof p.change_7d === 'number' && Number.isFinite(p.change_7d)
          ? p.change_7d
          : null,
      mcap_usd:
        typeof p.mcap_usd === 'number' && Number.isFinite(p.mcap_usd)
          ? p.mcap_usd
          : null,
      listed_at: typeof p.listed_at === 'string' ? p.listed_at : null,
      gecko_id: typeof p.gecko_id === 'string' ? p.gecko_id : null,
      symbol: typeof p.symbol === 'string' ? p.symbol : null,
    };
  });

  return {
    as_of: o.as_of,
    source: o.source,
    floor_usd: o.floor_usd,
    protocols,
    watchlist: o.watchlist as string[],
  };
}

// ---- board validation (gate check) ----

/**
 * Validate a board against its snapshot.
 * Returns null when the board passes; otherwise a description of the first failure.
 * Checks: watchlist coverage, rank monotonicity, value ordering, value diversity,
 * farm step count/length, and positive integer implied values.
 */
export function boardIssue(board: BoardRow[], snapshot: Snapshot): string | null {
  // Every watchlist slug must appear.
  const slugs = new Set(board.map((r) => r.slug));
  const missing = snapshot.watchlist.filter((s) => !slugs.has(s));
  if (missing.length > 0)
    return `the board misses ${missing.length} watchlist slug${missing.length === 1 ? '' : 's'}: ${missing.slice(0, 5).join(', ')}`;

  // Ranks must be 1..N with no gaps or duplicates.
  const ranks = board.map((r) => r.rank).sort((a, b) => a - b);
  for (let i = 0; i < ranks.length; i++)
    if (ranks[i] !== i + 1) return `rank ${i + 1} is ${ranks[i]}`;

  // Implied values must be non-increasing (ties allowed within a rank but never across).
  for (let i = 1; i < board.length; i++)
    if (board[i]!.implied_value_usd > board[i - 1]!.implied_value_usd)
      return `row ${i + 1} outranks row ${i} on implied value`;

  // All rows can't share the same implied value; that's not a ranking.
  if (
    board.length >= 2 &&
    board[0]!.implied_value_usd === board[board.length - 1]!.implied_value_usd
  ) {
    return `all ${board.length} rows share the same implied value $${board[0]!.implied_value_usd}: a board that ranks nothing by value is not a ranking`;
  }

  // Per-row checks.
  for (const r of board) {
    const steps = r.farm_steps;
    if (steps.length < 3 || steps.length > 12)
      return `${r.slug} has ${steps.length} farm steps`;
    for (const s of steps)
      if (s.length < 20 || s.length > 600)
        return `${r.slug} has a farm step of ${s.length} characters`;
    if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd <= 0)
      return `${r.slug} has implied value ${r.implied_value_usd}`;
  }

  return null;
}

// ---- data.js script for the static dashboard ----

/** The dashboard's whole dataset as a single no-network script. */
export function dataScript(radar: RadarData): string {
  return `window.RADAR=${JSON.stringify(radar)};\n`;
}