// The token radar's model: one snapshot of the protocol universe in, one ranked board out.
//
// The board covers every slug in the snapshot's watchlist (the floor, never a ceiling) and adds pre-token
// protocols below that floor, down to a TVL floor of $1M: the early rows the radar exists to find.
// A protocol is pre-token when its index entry records no token (no market cap, no CoinGecko id, no
// symbol); live-token protocols are kept apart, never mixed into the ranked board.
//
// Every row is one function of the snapshot's own figures; no protocol name is special-cased:
//
//   base      = tvl_usd x base_multiple
//   growth    = clamp(change_7d, growth_floor, growth_cap) per cent
//   growthMul = 1 + growth/100 x weight, where upside is weighted growth_weight_up and downside only
//               growth_weight_down: a pre-token winner has option-like upside and a capped downside.
//   maturity  = maturity_floor + maturity_range x min(x, 1-x) x 2 with x = clamp(age,0,maturity_days)/
//               maturity_days: a triangle peaking mid-life. Brand-new protocols have no record yet, and
//               very old ones had years to launch a token and chose not to; the sweet spot is the middle.
//   chainMul  = 1 + min(chains - 1, chain_cap) x chain_step: each chain beyond the first is another set
//               of users and another airdrop leg, so it buys a small multiplier up to a cap.
//   relevance = relevance_weight + (1 - relevance_weight) x clamp(log10(tvl/1M)/3, 0, 1): TVL on a log
//               scale, so a $1B protocol outranks a $1M one with the same growth, but not infinitely.
//   implied   = max(1, round(base x growthMul x maturity x chainMul x relevance))
//
// The constants are the house model's, stated in the dashboard and changeable in the model sandbox.
// The page recomputes every row from the raw figures with the same arithmetic and checks the board.

/** The snapshot's protocol entry: exactly the ten fields the sealed input carries. */
export interface SnapshotProtocol {
  slug: string; name: string; category: string | null; chains: string[];
  tvl_usd: number; change_7d: number | null; mcap_usd: number | null;
  listed_at: string | null; gecko_id: string | null; symbol: string | null;
}

/** The whole snapshot document. */
export interface Snapshot {
  as_of: string; source: string; floor_usd: number;
  protocols: SnapshotProtocol[]; watchlist: string[];
}

/** The model's constants, as the dashboard states them and the sandbox may change them. */
export interface ModelConstants {
  base_multiple: number;
  growth_weight_up: number; growth_weight_down: number;
  growth_floor: number; growth_cap: number;
  maturity_floor: number; maturity_range: number; maturity_days: number; unknown_age_days: number;
  chain_step: number; chain_cap: number;
  relevance_weight: number; relevance_anchor_usd: number; relevance_span: number;
}

export const MODEL: ModelConstants = {
  base_multiple: 0.25,
  growth_weight_up: 0.7, growth_weight_down: 0.35,
  growth_floor: -60, growth_cap: 120,
  maturity_floor: 0.75, maturity_range: 0.45, maturity_days: 730, unknown_age_days: 365,
  chain_step: 0.035, chain_cap: 5,
  relevance_weight: 0.88, relevance_anchor_usd: 1_000_000, relevance_span: 3,
};

/** The model's version label: the dashboard names it and the rules quote it. */
export const MODEL_VERSION = 'radar-2-asym';

/** How many pre-token protocols below the watchlist floor the early radar carries, by TVL. */
export const EARLY_ROWS = 150;

/** The early radar's TVL floor: below this a pre-token protocol is too small to farm yet. */
export const EARLY_TVL_FLOOR_USD = MODEL.relevance_anchor_usd;

/** How many live-token protocols the Live token view carries, by market cap. */
export const LIVE_ROWS = 24;

/** A farm step: the action, what it costs, and how long it takes. */
export interface FarmStep { text: string; cost: string; time: string; }

/** One row of board.json: the ranked board's row. */
export interface BoardRow {
  rank: number; slug: string; name: string; category: string | null; chains: string[];
  tvl_usd: number; change_7d: number | null; mcap_usd: number | null;
  listed_at: string | null; gecko_id: string | null; symbol: string | null;
  token_status: 'pre-token'; age_days: number | null; implied_value_usd: number;
  model: {
    base_multiple: number; growth_pct: number; growth_multiplier: number;
    maturity_multiplier: number; chain_multiplier: number; relevance_multiplier: number;
    age_days: number | null;
  };
  farm_steps: string[];
}

/** The dashboard's compact view of one row. */
export interface RadarRow {
  rank: number; slug: string; name: string; category: string | null; chains: string[];
  tvl_usd: number; change_7d: number | null; mcap_usd: number | null; listed_at: string | null;
  age_days: number | null; implied_value_usd: number; growth_multiplier: number;
  maturity_multiplier: number; chain_multiplier: number; relevance_multiplier: number;
}

/** A live-token protocol: it already trades, so the board shows the market's own value, not a model's. */
export interface LiveRow {
  slug: string; name: string; category: string | null; chains: string[];
  tvl_usd: number; mcap_usd: number | null; change_7d: number | null;
}

/** Everything the dashboard needs: the board, the live set, and the model it runs. */
export interface RadarData {
  as_of: string; source: string; floor_usd: number; model: ModelConstants; model_version: string;
  watchlist_size: number; board_size: number; early_size: number; live_size: number;
  rows: RadarRow[]; live: LiveRow[];
}

/** Why the snapshot is not one this model can score. */
export class SnapshotError extends Error {
  constructor(message: string) { super(message); this.name = 'SnapshotError'; }
}

const DAY_MS = 86_400_000;
const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));
const round4 = (n: number): number => Math.round(n * 1e4) / 1e4;

/** A finite number, else `fallback`. */
function finite(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** A whole day count from `from` to `to`, clamped at zero; null when either date is absent or bad. */
export function ageDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const a = Date.parse(`${asOf}T00:00:00Z`);
  const b = Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, Math.floor((a - b) / DAY_MS));
}

/** What the score of one protocol is made of: the multipliers and the implied value they produce. */
export interface Score {
  implied: number; growthPct: number; growthMult: number; maturityMult: number;
  chainMult: number; relevanceMult: number; age: number | null;
}

/** The four multipliers and the implied value one protocol gets under `model`. */
export function impliedValue(protocol: SnapshotProtocol, asOf: string, model: ModelConstants): Score {
  // A model whose anchors are not positive numbers can only produce NaN ranks; refuse it loudly.
  if (model.relevance_anchor_usd <= 0 || model.relevance_span <= 0 || model.maturity_days <= 0) {
    throw new RangeError(`the model's anchors must be positive: anchor ${model.relevance_anchor_usd}, span ${model.relevance_span}, maturity days ${model.maturity_days}`);
  }
  const age = ageDays(asOf, protocol.listed_at);
  const growthPct = clamp(finite(protocol.change_7d, 0), model.growth_floor, model.growth_cap);
  // Asymmetric weights: upside counts for more than downside.
  const weight = growthPct >= 0 ? model.growth_weight_up : model.growth_weight_down;
  const growthMult = 1 + (growthPct / 100) * weight;
  const ageForModel = age ?? model.unknown_age_days;
  const x = clamp(ageForModel, 0, model.maturity_days) / model.maturity_days;
  // The maturity triangle: peaks at half the maturity window, back to the floor at its edges.
  const maturityMult = model.maturity_floor + model.maturity_range * Math.min(x, 1 - x) * 2;
  const extraChains = clamp(protocol.chains.length - 1, 0, model.chain_cap);
  const chainMult = 1 + extraChains * model.chain_step;
  // TVL relevance on a log scale, floored at relevance_weight so small protocols stay visible.
  const logArg = Math.log10(Math.max(1, protocol.tvl_usd) / model.relevance_anchor_usd);
  const relevanceMult = model.relevance_weight + (1 - model.relevance_weight) * clamp(logArg / model.relevance_span, 0, 1);
  const base = protocol.tvl_usd * model.base_multiple;
  const implied = Math.max(1, Math.round(base * growthMult * maturityMult * chainMult * relevanceMult));
  return { implied, growthPct, growthMult, maturityMult, chainMult, relevanceMult, age };
}

/** DefiLlama's version-marker rule: a name ending in a release is a pool of another protocol. */
const VERSIONED = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;

/** Whether a protocol records no token at all. */
export function isPreToken(p: SnapshotProtocol): boolean {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}

/** Whether a protocol is one the board may rank: pre-token, not an exchange, not a versioned pool. */
export function isRankable(p: SnapshotProtocol): boolean {
  return isPreToken(p) && p.category !== 'CEX' && !VERSIONED.test(p.name);
}

/** The snapshot's protocol by slug. */
function bySlug(protocols: SnapshotProtocol[]): Map<string, SnapshotProtocol> {
  return new Map(protocols.map((p) => [p.slug, p]));
}

/** The protocols the board ranks, strongest first, with ranks 1..n. */
export function buildBoard(snapshot: Snapshot, model: ModelConstants = MODEL): BoardRow[] {
  const index = bySlug(snapshot.protocols);
  const chosen = new Map<string, SnapshotProtocol>();
  // The watchlist is the floor: every slug the board must carry, even one the snapshot no longer holds.
  for (const slug of snapshot.watchlist) {
    const p = index.get(slug);
    if (p !== undefined) chosen.set(slug, p);
  }
  // The early radar: pre-token protocols below the watchlist floor and above the TVL floor, by TVL,
  // capped. Never a replacement for a watchlist row: a chosen protocol stays chosen.
  const early = snapshot.protocols
    .filter((p) => !chosen.has(p.slug) && isRankable(p) && p.tvl_usd < snapshot.floor_usd && p.tvl_usd >= EARLY_TVL_FLOOR_USD)
    .sort((a, b) => b.tvl_usd - a.tvl_usd || (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0))
    .slice(0, EARLY_ROWS);
  for (const p of early) chosen.set(p.slug, p);

  const scored = [...chosen.values()].map((p) => ({ p, score: impliedValue(p, snapshot.as_of, model) }));
  scored.sort((a, b) => b.score.implied - a.score.implied || (a.p.slug < b.p.slug ? -1 : a.p.slug > b.p.slug ? 1 : 0));
  return scored.map((s, i) => ({
    rank: i + 1,
    slug: s.p.slug, name: s.p.name, category: s.p.category, chains: s.p.chains,
    tvl_usd: s.p.tvl_usd, change_7d: s.p.change_7d, mcap_usd: s.p.mcap_usd, listed_at: s.p.listed_at,
    gecko_id: s.p.gecko_id, symbol: s.p.symbol,
    token_status: 'pre-token', age_days: s.score.age, implied_value_usd: s.score.implied,
    model: {
      base_multiple: model.base_multiple, growth_pct: round4(s.score.growthPct),
      growth_multiplier: round4(s.score.growthMult), maturity_multiplier: round4(s.score.maturityMult),
      chain_multiplier: round4(s.score.chainMult), relevance_multiplier: round4(s.score.relevanceMult),
      age_days: s.score.age,
    },
    farm_steps: farmSteps(s.p, s.score.age).map(stepText),
  }));
}

/** A step as one string: its action, then its cost and time, within the gate's 20..600 characters. */
export function stepText(step: FarmStep): string {
  let s = `${step.text} Cost: ${step.cost}. Time: ${step.time}.`;
  if (s.length > 600) s = `${s.slice(0, 596)}...`;
  if (s.length < 20) s = `${s} Hold the position and check the protocol's own page.`;
  return s;
}

/** The first chain a protocol names, or a neutral phrase. */
function chainOf(p: SnapshotProtocol): string {
  return p.chains.length > 0 ? p.chains[0]! : 'its main chain';
}

/** How much capital one farm position needs, from the protocol's own TVL. */
function capitalFor(p: SnapshotProtocol): number {
  if (p.tvl_usd >= 5_000_000_000) return 250;
  if (p.tvl_usd >= 1_000_000_000) return 150;
  if (p.tvl_usd >= 100_000_000) return 100;
  return 50;
}

/** How long to hold, from the protocol's age: younger protocols get a longer qualifying window. */
function holdDaysFor(age: number | null): number {
  if (age === null) return 30;
  if (age < 180) return 60;
  if (age < 365) return 45;
  return 30;
}

/** The category's one action, in the words a farmer can follow, from a keyword table. */
function actionFor(p: SnapshotProtocol, capital: number, chain: string): string {
  const c = (p.category ?? '').toLowerCase();
  const rules: Array<[string[], string]> = [
    [['lend', 'cdp', 'collateral'], `Supply $${capital} of USDC to ${p.name} on ${chain} and keep the position open.`],
    [['dex', 'yield', 'leveraged farm'], `Provide $${capital} of liquidity to ${p.name}'s main pool on ${chain} and keep the position open.`],
    [['bridge'], `Bridge $${capital} of USDC to ${chain} through ${p.name} and use the bridged funds in its app.`],
    [['staking', 'restak'], `Stake $${capital} of the chain's staking asset through ${p.name} and keep the receipt.`],
    [['perpetual', 'derivative'], `Deposit $${capital} of USDC as margin on ${p.name} and open one small hedge.`],
    [['prediction'], `Fund $${capital} and place one market position on ${p.name}.`],
    [['curator', 'allocator'], `Deposit $${capital} into a ${p.name} vault on ${chain} and keep the shares.`],
    [['stable'], `Mint or deposit $${capital} of the stable asset through ${p.name} on ${chain}.`],
    [['rwa'], `Mint $${capital} of the protocol's yield asset on ${chain} and hold it.`],
    [['insurance'], `Buy $${capital} of cover from ${p.name} on ${chain} and keep the policy.`],
  ];
  for (const [keys, text] of rules) if (keys.some((k) => c.includes(k))) return text;
  return `Deposit $${capital} of USDC into ${p.name} on ${chain} and keep the position open.`;
}

/**
 * A protocol's farm plan: six steps, each an action with a cost and a time. The plan is derived from
 * the protocol's own record (category, chains, TVL, age), never from a hand-written list of names.
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

/** The live-token protocols, by market cap, for the dashboard's Live token view. */
export function liveRows(snapshot: Snapshot): LiveRow[] {
  return snapshot.protocols
    .filter((p) => !isPreToken(p) && p.category !== 'CEX')
    .sort((a, b) => (b.mcap_usd ?? 0) - (a.mcap_usd ?? 0) || b.tvl_usd - a.tvl_usd)
    .slice(0, LIVE_ROWS)
    .map((p) => ({
      slug: p.slug, name: p.name, category: p.category, chains: p.chains,
      tvl_usd: p.tvl_usd, mcap_usd: p.mcap_usd, change_7d: p.change_7d,
    }));
}

/** A board row's compact form for data.js. */
export function radarRow(row: BoardRow): RadarRow {
  return {
    rank: row.rank, slug: row.slug, name: row.name, category: row.category, chains: row.chains,
    tvl_usd: row.tvl_usd, change_7d: row.change_7d, mcap_usd: row.mcap_usd, listed_at: row.listed_at,
    age_days: row.age_days, implied_value_usd: row.implied_value_usd,
    growth_multiplier: row.model.growth_multiplier, maturity_multiplier: row.model.maturity_multiplier,
    chain_multiplier: row.model.chain_multiplier, relevance_multiplier: row.model.relevance_multiplier,
  };
}

/** Everything the dashboard renders, from the snapshot. */
export function buildRadar(snapshot: Snapshot, model: ModelConstants = MODEL): { board: BoardRow[]; radar: RadarData } {
  const board = buildBoard(snapshot, model);
  const live = liveRows(snapshot);
  const early = board.filter((r) => !snapshot.watchlist.includes(r.slug)).length;
  const radar: RadarData = {
    as_of: snapshot.as_of, source: snapshot.source, floor_usd: snapshot.floor_usd,
    model, model_version: MODEL_VERSION,
    watchlist_size: snapshot.watchlist.length, board_size: board.length,
    early_size: early, live_size: live.length,
    rows: board.map(radarRow), live,
  };
  return { board, radar };
}

/** One protocol of the snapshot, or a SnapshotError naming its place. */
function parseProtocol(v: unknown, i: number): SnapshotProtocol {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new SnapshotError(`snapshot.json's protocol ${i} is not an object`);
  const p = v as Record<string, unknown>;
  if (typeof p.slug !== 'string' || typeof p.name !== 'string' || typeof p.tvl_usd !== 'number' || !Number.isFinite(p.tvl_usd)) {
    throw new SnapshotError(`snapshot.json's protocol ${i} lacks a slug, a name or a TVL`);
  }
  return {
    slug: p.slug, name: p.name,
    category: typeof p.category === 'string' ? p.category : null,
    chains: Array.isArray(p.chains) ? p.chains.filter((c): c is string => typeof c === 'string') : [],
    tvl_usd: p.tvl_usd,
    change_7d: typeof p.change_7d === 'number' && Number.isFinite(p.change_7d) ? p.change_7d : null,
    mcap_usd: typeof p.mcap_usd === 'number' && Number.isFinite(p.mcap_usd) ? p.mcap_usd : null,
    listed_at: typeof p.listed_at === 'string' ? p.listed_at : null,
    gecko_id: typeof p.gecko_id === 'string' ? p.gecko_id : null,
    symbol: typeof p.symbol === 'string' ? p.symbol : null,
  };
}

/** The snapshot out of a file's text, refused unless it is the shape the model scores. */
export function parseSnapshot(text: string): Snapshot {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SnapshotError('snapshot.json is not JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new SnapshotError('snapshot.json is not a JSON object');
  const o = raw as Record<string, unknown>;
  if (typeof o.as_of !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(o.as_of)) throw new SnapshotError('snapshot.json has no as_of date');
  if (typeof o.source !== 'string') throw new SnapshotError('snapshot.json has no source');
  if (typeof o.floor_usd !== 'number' || !Number.isSafeInteger(o.floor_usd) || o.floor_usd <= 0) throw new SnapshotError('snapshot.json has no floor_usd');
  if (!Array.isArray(o.protocols)) throw new SnapshotError('snapshot.json has no protocols array');
  if (!Array.isArray(o.watchlist) || o.watchlist.some((s) => typeof s !== 'string')) throw new SnapshotError('snapshot.json has no watchlist of slugs');
  return {
    as_of: o.as_of, source: o.source, floor_usd: o.floor_usd,
    protocols: o.protocols.map(parseProtocol),
    watchlist: o.watchlist as string[],
  };
}

/** Why a board is not one the gate will take, or null: coverage, ranks, order, one shared implied value, and farm steps. */
export function boardIssue(board: BoardRow[], snapshot: Snapshot): string | null {
  const slugs = new Set(board.map((r) => r.slug));
  if (slugs.size !== board.length) return 'the board names one protocol twice';
  const missing = snapshot.watchlist.filter((s) => !slugs.has(s));
  if (missing.length > 0) return `the board misses ${missing.length} watchlist slug${missing.length === 1 ? '' : 's'}: ${missing.slice(0, 5).join(', ')}`;
  const ranks = board.map((r) => r.rank).sort((a, b) => a - b);
  for (let i = 0; i < ranks.length; i++) if (ranks[i] !== i + 1) return `rank ${i + 1} is ${ranks[i]}`;
  for (let i = 1; i < board.length; i++) {
    const prev = board[i - 1]!, row = board[i]!;
    if (row.implied_value_usd > prev.implied_value_usd) return `row ${i + 1} outranks row ${i} on implied value`;
    if (row.implied_value_usd === prev.implied_value_usd && row.slug <= prev.slug) return `rows ${i} and ${i + 1} share an implied value but break the name order`;
  }
  if (board.length >= 2 && board[0]!.implied_value_usd === board[board.length - 1]!.implied_value_usd) {
    return `all ${board.length} rows share the same implied value $${board[0]!.implied_value_usd}: a board that ranks nothing by value is not a ranking`;
  }
  for (const r of board) {
    if (r.token_status !== 'pre-token') return `${r.slug} is not recorded as pre-token`;
    if (r.symbol !== null || r.gecko_id !== null || r.mcap_usd !== null) return `${r.slug} records a token: it must be scored by the market, not the model`;
    if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd <= 0) return `${r.slug} has implied value ${r.implied_value_usd}`;
    const steps = r.farm_steps;
    if (steps.length < 3 || steps.length > 12) return `${r.slug} has ${steps.length} farm steps`;
    for (const s of steps) if (s.length < 20 || s.length > 600) return `${r.slug} has a farm step of ${s.length} characters`;
    if (!r.model || typeof r.model.growth_multiplier !== 'number' || r.model.growth_multiplier <= 0) return `${r.slug} lacks a growth multiplier`;
  }
  return null;
}

/** A compact data.js: the dashboard's whole dataset as one script, no fetch and no network. */
export function dataScript(radar: RadarData): string {
  return `window.RADAR=${JSON.stringify(radar)};\n`;
}