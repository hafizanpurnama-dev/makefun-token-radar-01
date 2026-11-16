# Token Launch Radar — Solana

Real-time radar for new SPL token launches on Solana. Detects mint creation on
both the original Token Program and Token 2022 Program, fetches on-chain
metadata, and outputs structured radar data.

## Quick Start

```bash
# Install dependencies
npm install

# Start live monitoring
npx tsx main.ts

# One-shot scan, JSON output
npx tsx main.ts --once --json

# Custom RPC with polling fallback
npx tsx main.ts --rpc https://your-rpc.com --poll 30
```

**Node.js >= 22 required.**

## How It Works

1. **WebSocket subscription** — `onLogs` monitors both `Tokenkeg…` and
   `Tokenz…` (Token 2022) programs in real time. Log messages are pre-filtered
   for `InitializeMint` / `InitializeMint2` before any RPC call.

2. **Polling fallback** — every N seconds, `getSignaturesForAddress` scans
   recent transactions from both programs. Already-seen signatures are skipped.

3. **Transaction parsing** — `getParsedTransaction` extracts the mint address,
   decimals, mint authority, and supply. Rate-limited RPCs get exponential
   backoff.

4. **Metadata enrichment** — Metaplex Token Metadata PDA is fetched for name,
   symbol, and URI.

5. **Output** — each detection prints a formatted summary (or JSON line with
   `--json`).

## RPC Notes

The public `api.mainnet-beta.solana.com` endpoint is heavily rate-limited and
unreliable for sustained monitoring. For production use, provide a dedicated
RPC via `--rpc`:

- [Helius](https://helius.dev) (free tier: 10 RPS)
- [QuickNode](https://quicknode.com)
- [Triton](https://triton.one)
- [Shyft](https://shyft.to)

## CLI Options

```
Usage: token-radar [options]

Options:
  --rpc <url>       Solana RPC endpoint (default: auto-select)
  --poll <seconds>  Polling interval in seconds (default: 15)
  --once            Single scan, then exit
  --json            Output entries as newline-delimited JSON
  --limit <n>       Max signatures per poll per program (default: 20)
  --max <n>         Stop after N detections (default: unlimited)
```

## JSON Output Schema

```typescript
interface TokenRadarEntry {
  mint: string;           // Token mint address
  signature: string;      // Mint creation transaction
  timestamp: number;      // Block time (Unix seconds)
  decimals: number;       // Token decimals
  mintAuthority: string | null;  // null = fixed supply
  supply: string;         // Initial supply
  name: string | null;    // From Metaplex metadata
  symbol: string | null;  // From Metaplex metadata
  uri: string | null;     // Metadata URI
  detection: "realtime" | "poll";
  program: "token" | "token-2022";
}
```

## License

MIT