#!/usr/bin/env npx tsx
/**
 * Token Launch Radar — Solana
 *
 * Monitors the Solana blockchain for new SPL token launches in real time.
 * Tracks key metrics (mint address, authority, decimals, supply, metadata)
 * and outputs structured radar data.
 *
 * Usage:
 *   npx tsx main.ts                          # live monitoring via WebSocket
 *   npx tsx main.ts --rpc <url> --poll 30    # custom RPC, poll every 30s
 *   npx tsx main.ts --once --json            # one-shot scan, JSON output
 */

import { Command } from "commander";
import {
  Connection,
  PublicKey,
  type ParsedInstruction,
  type PartiallyDecodedInstruction,
  type Logs,
} from "@solana/web3.js";

// ── Constants ────────────────────────────────────────────────────────────────

/** Original SPL Token program */
const TOKEN_PROGRAM_ID = new PublicKey(
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
);
/** SPL Token 2022 program (most new launches use this) */
const TOKEN_2022_PROGRAM_ID = new PublicKey(
  "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
);
const METADATA_PROGRAM_ID = new PublicKey(
  "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s",
);

/** Log messages that indicate a token mint creation */
const MINT_LOG_SIGNATURES = [
  "Instruction: InitializeMint",
  "Instruction: InitializeMint2",
];

// Default RPC endpoints (tried in order if not specified)
const DEFAULT_RPCS = [
  "https://api.mainnet-beta.solana.com",
  "https://solana-mainnet.rpc.extrnode.com",
];

// ── Types ────────────────────────────────────────────────────────────────────

export interface TokenRadarEntry {
  /** Token mint address */
  mint: string;
  /** Transaction that created the mint */
  signature: string;
  /** Block timestamp (Unix seconds) */
  timestamp: number;
  /** Number of decimals */
  decimals: number;
  /** Mint authority (null = fixed supply) */
  mintAuthority: string | null;
  /** Initial supply in smallest units */
  supply: string;
  /** Token name from Metaplex metadata (if available) */
  name: string | null;
  /** Token symbol from Metaplex metadata (if available) */
  symbol: string | null;
  /** URI of token metadata (if available) */
  uri: string | null;
  /** Detection method: "realtime" or "poll" */
  detection: "realtime" | "poll";
  /** Which token program: "token" or "token-2022" */
  program: "token" | "token-2022";
}

export interface RadarStats {
  totalDetected: number;
  startTime: number;
  lastDetection: number | null;
  detectionRate: number; // tokens per minute
}

// ── Utility ──────────────────────────────────────────────────────────────────

function now(): number {
  return Math.floor(Date.now() / 1000);
}

function formatTime(unix: number): string {
  return new Date(unix * 1000).toISOString();
}

/** Check if log messages indicate a token mint creation */
function logsContainMint(logs: Logs): boolean {
  const msgs = logs.logs ?? [];
  return MINT_LOG_SIGNATURES.some((sig) =>
    msgs.some((m) => m.includes(sig)),
  );
}

async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ── Metadata lookup ──────────────────────────────────────────────────────────

/**
 * Derive the Metaplex Token Metadata PDA for a given mint.
 */
function getMetadataPDA(mint: PublicKey): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [
      Buffer.from("metadata"),
      METADATA_PROGRAM_ID.toBuffer(),
      mint.toBuffer(),
    ],
    METADATA_PROGRAM_ID,
  );
  return pda;
}

interface TokenMetadata {
  name: string;
  symbol: string;
  uri: string;
}

/**
 * Fetch on-chain Metaplex metadata for a token mint.
 * Returns null if no metadata account exists.
 */
async function fetchMetadata(
  connection: Connection,
  mint: PublicKey,
): Promise<TokenMetadata | null> {
  const metadataPDA = getMetadataPDA(mint);
  try {
    const accountInfo = await connection.getAccountInfo(metadataPDA);
    if (!accountInfo || !accountInfo.data) return null;

    const data = accountInfo.data;
    // Metaplex metadata layout:
    // byte 0: key (4 = Metadata)
    // bytes 1-32: update authority
    // bytes 33-64: mint
    // bytes 65+: data variant
    if (data[0] !== 4) return null;

    let offset = 1 + 32 + 32; // skip key + updateAuthority + mint

    const readString = (): string => {
      const len = data.readUInt32LE(offset);
      offset += 4;
      const str = data.subarray(offset, offset + len).toString("utf8").replace(/\0/g, "");
      offset += len;
      return str.trim();
    };

    offset += 1; // skip "data" variant key
    const name = readString();
    const symbol = readString();
    const uri = readString();

    return { name, symbol, uri };
  } catch {
    return null;
  }
}

// ── Mint detection ───────────────────────────────────────────────────────────

/**
 * Extract InitializeMint / InitializeMint2 details from a parsed instruction.
 * Handles both original Token Program and Token 2022 formats.
 */
function extractMintFromIx(
  ix: ParsedInstruction | PartiallyDecodedInstruction,
): {
  mint: string;
  decimals: number;
  mintAuthority: string | null;
  supply: string;
  program: "token" | "token-2022";
} | null {
  // Parsed instruction (richer RPCs like Helius, or when parsing works)
  if ("parsed" in ix && ix.parsed) {
    const p = ix.parsed as any;
    const type = p.type;
    if (type === "initializeMint" || type === "initializeMint2") {
      const info = p.info;
      return {
        mint: info.mint,
        decimals: info.decimals,
        mintAuthority: info.mintAuthority ?? null,
        supply: info.supply ?? "0",
        program: type === "initializeMint2" ? "token-2022" : "token",
      };
    }
  }

  // Partially decoded (standard RPCs) — check discriminator
  // initializeMint: first 2 bytes = [0,0]
  // Token 2022 InitializeMint2: first 2 bytes = 16 (0x10) followed by the ix index
  if ("data" in ix && ix.data) {
    const data = Buffer.from(ix.data as any, "base64");
    if (data.length < 2) return null;

    const isInitMint = data[0] === 0 && data[1] === 0; // original Token
    const isInitMint2 = false; // Token 2022 has variable discriminator — rely on parsed

    if (!isInitMint && !isInitMint2) return null;

    let offset = 2;
    const decimals = data[offset++];
    const mintAuthorityRaw = data.subarray(offset, offset + 32);
    offset += 32;
    const hasFreeze = data[offset++] === 1;
    if (hasFreeze) offset += 32;

    const mintAuthority = mintAuthorityRaw.every((b) => b === 0)
      ? null
      : new PublicKey(mintAuthorityRaw).toBase58();

    const accounts = (ix as any).accounts;
    const mint =
      typeof accounts?.[0] === "string"
        ? accounts[0]
        : accounts?.[0]?.pubkey?.toBase58?.() ??
          accounts?.[0]?.toString?.() ??
          null;

    if (!mint) return null;
    return {
      mint,
      decimals,
      mintAuthority,
      supply: "0",
      program: "token",
    };
  }

  return null;
}

// ── Live monitor (WebSocket logsSubscribe) ───────────────────────────────────

/**
 * Start real-time monitoring via onLogs subscription.
 * Subscribes to BOTH Token Program and Token 2022 Program.
 * Pre-filters by log messages before fetching tx details to avoid rate limits.
 */
function startLiveMonitor(
  connection: Connection,
  onToken: (
    entry: Omit<TokenRadarEntry, "name" | "symbol" | "uri">,
  ) => void,
): { abort: () => void } {
  const subIds: number[] = [];

  // Retry helper for rate-limited getParsedTransaction calls
  async function fetchTxWithRetry(
    signature: string,
  ): Promise<ReturnType<typeof connection.getParsedTransaction>> {
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        return await connection.getParsedTransaction(signature, {
          maxSupportedTransactionVersion: 1,
          commitment: "confirmed",
        });
      } catch (err: any) {
        if (err?.code === 429 && attempt < 3) {
          await sleep(1000 * (attempt + 1)); // backoff: 1s, 2s, 3s
          continue;
        }
        throw err;
      }
    }
    return null;
  }

  // Subscribe to logs from both token programs
  for (const programId of [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID]) {
    const subId = connection.onLogs(
      programId,
      async (logs) => {
        if (logs.err) return;
        // Pre-filter: only process if logs contain an initializeMint message
        if (!logsContainMint(logs)) return;

        try {
          const tx = await fetchTxWithRetry(logs.signature);
          if (!tx || !tx.blockTime) return;

          for (const ix of tx.transaction.message.instructions) {
            const parsed = extractMintFromIx(ix as any);
            if (parsed) {
              onToken({
                ...parsed,
                signature: logs.signature,
                timestamp: tx.blockTime,
                detection: "realtime" as const,
              });
              break;
            }
          }
        } catch {
          // tx fetch failed; will be caught by polling fallback
        }
      },
      "confirmed",
    );
    subIds.push(subId);
  }

  return {
    abort: () => {
      for (const id of subIds) {
        connection.removeOnLogsListener(id);
      }
    },
  };
}

// ── Polling monitor ──────────────────────────────────────────────────────────

async function pollRecentMints(
  connection: Connection,
  seenSigs: Set<string>,
  limit: number = 50,
): Promise<Array<Omit<TokenRadarEntry, "name" | "symbol" | "uri">>> {
  const results: Array<Omit<TokenRadarEntry, "name" | "symbol" | "uri">> = [];

  for (const programId of [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID]) {
    try {
      const sigs = await connection.getSignaturesForAddress(programId, { limit }, "confirmed");

      for (const sig of sigs) {
        if (seenSigs.has(sig.signature)) continue;
        if (sig.err) continue;

        try {
          await sleep(150); // rate-limit on public RPCs

          const tx = await connection.getParsedTransaction(sig.signature, {
            maxSupportedTransactionVersion: 1,
            commitment: "confirmed",
          });

          if (!tx || !tx.blockTime) continue;

          for (const ix of tx.transaction.message.instructions) {
            const parsed = extractMintFromIx(ix as any);
            if (parsed) {
              seenSigs.add(sig.signature);
              results.push({
                ...parsed,
                signature: sig.signature,
                timestamp: tx.blockTime,
                detection: "poll" as const,
              });
              break;
            }
          }
        } catch (err: any) {
          if (err?.message?.includes("429") || err?.code === 429) break;
          continue;
        }
      }
    } catch (err: any) {
      console.error(`[radar] Poll error (${programId.toBase58().slice(0, 6)}…): ${err.message}`);
    }
  }

  return results;
}

// ── Rich entry builder (fetch metadata + enrich) ────────────────────────────

async function enrichEntry(
  connection: Connection,
  entry: Omit<TokenRadarEntry, "name" | "symbol" | "uri">,
): Promise<TokenRadarEntry> {
  let metadata: TokenMetadata | null = null;
  try {
    metadata = await fetchMetadata(connection, new PublicKey(entry.mint));
  } catch {
    // metadata is optional
  }

  return {
    ...entry,
    name: metadata?.name ?? null,
    symbol: metadata?.symbol ?? null,
    uri: metadata?.uri ?? null,
  };
}

// ── Display ───────────────────────────────────────────────���──────────────────

function formatEntry(entry: TokenRadarEntry, index: number): string {
  const lines = [
    `┌──── Token Launch #${index} ────`,
    `│ Mint:          ${entry.mint}`,
    `│ Name:          ${entry.name ?? "(no metadata)"}`,
    `│ Symbol:        ${entry.symbol ?? "—"}`,
    `│ Decimals:      ${entry.decimals}`,
    `│ Authority:     ${entry.mintAuthority ?? "(fixed supply)"}`,
    `│ Supply:        ${entry.supply}`,
    `│ Program:       ${entry.program}`,
    `│ TX:            ${entry.signature}`,
    `│ Time:          ${formatTime(entry.timestamp)}`,
    `│ Detection:     ${entry.detection}`,
    `│ URI:           ${entry.uri ?? "—"}`,
    `└────────────────────────────────`,
  ];
  return lines.join("\n");
}

function printStats(stats: RadarStats): void {
  const uptime = now() - stats.startTime;
  const mins = Math.floor(uptime / 60);
  const secs = uptime % 60;
  console.log(
    `\n[radar] Uptime: ${mins}m ${secs}s | Detected: ${stats.totalDetected} | Rate: ${stats.detectionRate.toFixed(1)}/min`,
  );
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const program = new Command();

  program
    .name("token-radar")
    .description(
      "Solana token launch radar — detect and track new SPL token mints",
    )
    .option("--rpc <url>", "Solana RPC endpoint (default: auto-select)")
    .option(
      "--poll <seconds>",
      "Polling interval in seconds (default: 15)",
      "15",
    )
    .option("--once", "Single scan, then exit")
    .option("--json", "Output entries as newline-delimited JSON")
    .option(
      "--limit <n>",
      "Max signatures to fetch per poll per program (default: 20)",
      "20",
    )
    .option("--max <n>", "Stop after N detections (default: unlimited)", "0")
    .parse();

  const opts = program.opts<{
    rpc?: string;
    poll: string;
    once?: boolean;
    json?: boolean;
    limit: string;
    max: string;
  }>();

  const pollInterval = Math.max(5, parseInt(opts.poll, 10) || 15);
  const fetchLimit = Math.max(1, parseInt(opts.limit, 10) || 20);
  const maxDetections = parseInt(opts.max, 10) || 0;

  // Resolve RPC endpoint
  let rpcUrl = opts.rpc || DEFAULT_RPCS[0];
  if (!opts.rpc) {
    for (const url of DEFAULT_RPCS) {
      try {
        const testConn = new Connection(url, "confirmed");
        await testConn.getBlockHeight();
        rpcUrl = url;
        break;
      } catch {
        continue;
      }
    }
  }

  console.log(
    `[radar] Connecting to ${rpcUrl.replace(/api-key=[^&]+/, "api-key=***")}`,
  );

  // Derive WebSocket endpoint from HTTPS URL
  const wsUrl = rpcUrl.replace("https://", "wss://").replace("http://", "ws://");
  const connection = new Connection(rpcUrl, {
    commitment: "confirmed",
    wsEndpoint: wsUrl,
  });

  const stats: RadarStats = {
    totalDetected: 0,
    startTime: now(),
    lastDetection: null,
    detectionRate: 0,
  };

  const seenSigs = new Set<string>();
  const allEntries: TokenRadarEntry[] = [];

  const handleNewToken = async (
    entry: Omit<TokenRadarEntry, "name" | "symbol" | "uri">,
  ) => {
    if (seenSigs.has(entry.signature)) return;
    seenSigs.add(entry.signature);

    const rich = await enrichEntry(connection, entry);
    allEntries.push(rich);
    stats.totalDetected++;
    stats.lastDetection = now();
    const elapsed = (stats.lastDetection - stats.startTime) / 60 || 1;
    stats.detectionRate = stats.totalDetected / elapsed;

    if (opts.json) {
      console.log(JSON.stringify(rich));
    } else {
      console.log(formatEntry(rich, stats.totalDetected));
      printStats(stats);
    }

    if (maxDetections > 0 && stats.totalDetected >= maxDetections) {
      console.log(
        `\n[radar] Reached max detections (${maxDetections}). Exiting.`,
      );
      process.exit(0);
    }
  };

  if (opts.once) {
    console.log("[radar] Single scan mode");
    const mints = await pollRecentMints(connection, seenSigs, fetchLimit);
    for (const entry of mints) {
      await handleNewToken(entry);
    }
    console.log(
      `\n[radar] Done. Detected ${stats.totalDetected} tokens in this scan.`,
    );
    return;
  }

  // Live + polling hybrid mode
  console.log(
    `[radar] Live monitoring (Token + Token-2022) + polling every ${pollInterval}s`,
  );

  let wsActive = false;
  const monitor = startLiveMonitor(connection, (entry) => {
    wsActive = true;
    handleNewToken(entry);
  });

  setTimeout(() => {
    if (!wsActive) {
      console.log("[radar] WebSocket idle — running poll-only mode");
    }
  }, 15_000);

  // Polling loop
  const pollLoop = async () => {
    const mints = await pollRecentMints(connection, seenSigs, fetchLimit);
    for (const entry of mints) {
      await handleNewToken(entry);
    }
  };

  // Initial poll
  await pollLoop();

  // Regular polling
  const interval = setInterval(pollLoop, pollInterval * 1000);

  // Graceful shutdown
  const shutdown = () => {
    console.log("\n[radar] Shutting down...");
    monitor.abort();
    clearInterval(interval);
    printStats(stats);
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error(`[radar] Fatal: ${err.message}`);
  process.exit(1);
});