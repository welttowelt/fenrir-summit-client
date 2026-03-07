# Summit Agent

Autonomous Starknet bot for the **Loot Survivor Summit** game. Continuously monitors the summit, ranks your beasts, and attacks the holder to earn `$SURVIVOR` rewards.

## How It Works

The Summit is a king-of-the-hill game in Loot Survivor. One beast holds the summit at a time, earning `0.007 $SURVIVOR/sec`. Anyone can attack the holder with their beasts. If you win, your beast takes the summit and you start earning.

This agent:
1. **Polls** the Summit API every 5s for the current holder and your beasts
2. **Scores** your beasts against the defender (power × type advantage × crit chance)
3. **Attacks** with up to 30 beasts per transaction, using VRF for combat randomness
4. **Retries** with a three-layer strategy when transactions fail:
   - **Layer 1**: Summit holder changed mid-tx → instant retry with fresh data
   - **Layer 2**: Beast revival mismatch → exclude that beast, retry with remaining
   - **Layer 3**: Unknown error → full refresh from API + backoff

## Architecture

```
src/
├── index.ts              # Main bot loop + three-layer retry
├── config.ts             # Zod-validated config schema
├── api/
│   ├── client.ts         # REST client for Summit API
│   ├── ws.ts             # WebSocket client for real-time events
│   └── types.ts          # API response types
├── chain/
│   ├── abi.ts            # ABI loader with caching
│   ├── client.ts         # Starknet chain client (SessionProvider + VRF)
│   └── controller-signer.ts  # Session validation helpers
├── strategy/
│   ├── engine.ts         # Decision engine (attack/wait logic)
│   ├── scoring.ts        # Beast enrichment + scoring + ranking
│   └── types.ts          # Game types (GameSnapshot, AgentAction, etc.)
├── data/
│   └── beasts.ts         # Beast metadata (75 beasts, types, tiers, names)
├── utils/
│   ├── logger.ts         # Structured logger + JSONL event writer
│   └── time.ts           # sleep() + retry()
├── cli/
│   ├── status.ts         # Quick status check
│   └── beasts.ts         # List your beasts with scores
└── bootstrap/
    ├── create-session.ts # Browser-based Cartridge session creation
    └── login.ts          # Session validation check
```

## Type Triangle

Combat uses rock-paper-scissors type advantages:
- **Magic** beats Brute (1.5× damage)
- **Hunter** beats Magic (1.5× damage)
- **Brute** beats Hunter (1.5× damage)
- Same type = 1.0×, disadvantage = 0.5×

## Beast Scoring

```
score = basePower × typeAdvantage × critFactor
basePower = level × (6 - tier)     // T1 = ×5, T5 = ×1
critFactor = 1 + (luck / 100)
```

Beasts are ranked by score; top N (up to `maxBeastsPerAttack`) are sent per attack.

## Setup

### Prerequisites
- Node.js ≥ 20
- A Cartridge Controller account with beasts in the Summit game

### Install

```bash
npm install
```

### Configure

```bash
cp config/example.json config/yourprofile.json
# Edit with your controller address and username
```

### Create Session

The bot uses Cartridge's session-based transactions (gasless via paymaster). You need to create a session by authenticating in the browser:

```bash
NODE_OPTIONS='--experimental-wasm-modules' npx tsx src/bootstrap/create-session.ts config/yourprofile.json
```

This opens a browser for Cartridge keychain login. The session is stored locally and expires after 7 days.

### Run

```bash
NODE_OPTIONS='--experimental-wasm-modules' npx tsx src/index.ts config/yourprofile.json
```

Or run in background:

```bash
NODE_OPTIONS='--experimental-wasm-modules' nohup npx tsx src/index.ts config/yourprofile.json > summit-agent.log 2>&1 &
```

### Cockpit (Web UI)

Fenrir now includes a local cockpit for multi-user profile operations:

- Create/load profile configs in `config/*.json`
- Tune strategy and potion controls from a single page
- Manage non-aggression pacts (friendly players) that auto-sync to protected owners
- Connect Cartridge wallet directly from the cockpit (browser flow)
- Launch Cartridge session registration
- Start/stop runners and watch live logs
- Edit full profile JSON in the cockpit when you need every field

Run:

```bash
npm run cockpit
```

Then open `http://127.0.0.1:8788`.

Single-user local mode (recommended for independent runners):

```bash
npm run cockpit:user
```

- Runs in isolated public-user storage (`public-config/`, `public-data/`)
- Binds backend to `127.0.0.1` so it is local to that machine
- Works with the hosted frontend; it auto-detects local backend at `127.0.0.1:8788` (no manual API input)

For external/public access:
- Server binds to `0.0.0.0` by default.
- Put it behind HTTPS (required for production wallet flows).
- Add authentication in front of cockpit APIs before exposing runner controls publicly.
- Use `npm run cockpit:public` so public users are isolated from your local profiles.
- Public mode stores profiles in `public-config/` and logs/session artifacts in `public-data/`.
- Public mode never lists your private `config/*.json` runner profiles.
- Cartridge wallet connect bundle is served locally from `/vendor/cartridge-controller.bundle.js` (no `esm.sh` dependency).
- Session registration is handled on-page (user approves in browser, then cockpit imports session to profile).

### CLI Tools

```bash
# Check summit status + your beasts
NODE_OPTIONS='--experimental-wasm-modules' npx tsx src/cli/status.ts config/yourprofile.json

# List all your beasts with scores against current holder
NODE_OPTIONS='--experimental-wasm-modules' npx tsx src/cli/beasts.ts config/yourprofile.json

# Find diplomacy opportunities by matching your beast names vs leaderboard
NODE_OPTIONS='--experimental-wasm-modules' npx tsx src/cli/diplomacy-scout.ts config/yourprofile.json

# Verify session is valid
NODE_OPTIONS='--experimental-wasm-modules' npx tsx src/bootstrap/login.ts config/yourprofile.json
```

## Strategy Config

| Option | Default | Description |
|--------|---------|-------------|
| `sendAllBeasts` | `true` | Send multiple beasts per attack |
| `maxBeastsPerAttack` | `30` | Cap on beasts per transaction |
| `avoidTypeDisadvantage` | `true` | Skip attacks where beast has type disadvantage |
| `requireTypeAdvantage` | `false` | Only attack with type-advantaged beasts |
| `attackCooldownMs` | `5000` | Minimum time between attacks |
| `useAttackPotions` | `true` | Use attack potions per beast |
| `attackPotionsPerBeast` | `5` | Number of potions per beast |
| `pauseOnAttackPotionDepleted` | `true` | Pause the runner when attack potion spend fails due to allowance/balance shortage |
| `useRevivalPotions` | `true` | Use revival potions per beast |
| `maxRevivalPotionsPerBeast` | `10` | Skip beasts needing more revives than this in one attack |
| `burstEnabled` | `true` | Enable high-extra-life burst combo mode |
| `burstExtraLivesThreshold` | `10` | Trigger burst mode when holder has at least this many extra lives |
| `burstAttackCountPerBeast` | `5` | Target attack count for burst combo (clamped by revival budget) |
| `burstAttackPotionsPerBeast` | `3` | Attack potions used on burst primary attacker |
| `burstMinTypeAdvantage` | `1.5` | Minimum type advantage for burst combo |
| `conservativeMode` | `false` | (Reserved for future cautious strategies) |

## Key Technical Details

- **VRF**: All attacks prepend a `request_random` call for Verifiable Random Function — required by the contract for combat randomness
- **Revert detection**: After `waitForTransaction`, checks `execution_status` for `REVERTED` to catch silent failures
- **WASM errors**: Cartridge SDK throws `JsControllerError` objects with `__wbg_ptr`; the bot decodes these to extract error messages
- **Hex felt decoding**: Starknet errors contain hex-encoded felt strings (e.g., `0x73657373696f6e2f...` = `session/...`); automatically decoded for pattern matching
- **starknet.js v6**: Uses positional args for `Contract(abi, address, provider)`, not object destructuring
- **blockIdentifier**: Cartridge RPC requires `"latest"` (rejects `"pending"`)

## Events

Attack events are logged to `data/yourprofile/events.jsonl` in structured JSONL format:
- `attack_success` — successful attack with tx hash, beasts sent, defender info
- `attack_failed` — failed attempt with error details and retry layer
- `attack_exhausted` — all 50 retry attempts failed
- `attack_all_excluded` — all beasts excluded via Layer 2 retry

## License

Private — Trisolaris
