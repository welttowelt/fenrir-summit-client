#!/usr/bin/env tsx

import SessionProvider from "@cartridge/controller/session/node";
import { Contract, RpcProvider, cairo } from "starknet";
import { loadConfig } from "../config.js";
import { loadSummitAbi } from "../chain/abi.js";

const SHALOMBRUDER = "0x00Df433279d2EeA7F73e8bdFBCE78931Ac768BF77fcE7d319149a7FD367D59a7";
const STRK_ADDRESS = "0x04718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d";
const DEFAULT_ROUTER = "0x04505a9f06f2bd639b6601f37a4dc0908bb70e8e0e0c34b1220827d64f4fc066";
const CHAIN_ID_SN_MAIN = "0x534e5f4d41494e";
const STRK_TRANSFER_AMOUNT = 2000n * 10n ** 18n; // 2000 STRK (18 decimals)

async function main() {
  const config = loadConfig("public-config/runner.json");
  const provider = new RpcProvider({ nodeUrl: config.chain.rpcUrl, blockIdentifier: "latest" });
  const abi = await loadSummitAbi(config.chain.rpcUrl, config.chain.summitContract);
  const contract = new Contract(abi, config.chain.summitContract, provider);

  // Get potion token addresses
  const attackAddr = "0x" + BigInt(await contract.call("get_attack_potion_address", [])).toString(16);
  const reviveAddr = "0x" + BigInt(await contract.call("get_revive_potion_address", [])).toString(16);
  console.log("ATTACK token:", attackAddr);
  console.log("REVIVE token:", reviveAddr);

  const erc20Abi = [
    { name: "balanceOf", type: "function", inputs: [{ name: "account", type: "core::starknet::contract_address::ContractAddress" }], outputs: [{ type: "core::integer::u256" }], state_mutability: "view" },
    { name: "transfer", type: "function", inputs: [{ name: "recipient", type: "core::starknet::contract_address::ContractAddress" }, { name: "amount", type: "core::integer::u256" }], outputs: [{ type: "core::bool" }], state_mutability: "external" },
  ];

  const attackToken = new Contract(erc20Abi, attackAddr, provider);
  const reviveToken = new Contract(erc20Abi, reviveAddr, provider);
  const strkToken = new Contract(erc20Abi, STRK_ADDRESS, provider);

  const atkBal = await attackToken.call("balanceOf", [config.account.controllerAddress]);
  const revBal = await reviveToken.call("balanceOf", [config.account.controllerAddress]);
  const strkBal = await strkToken.call("balanceOf", [config.account.controllerAddress]);

  const atkAmount = BigInt(atkBal as any);
  const revAmount = BigInt(revBal as any);
  const strkBalance = BigInt(strkBal as any);

  console.log("ATTACK balance:", atkAmount.toString());
  console.log("REVIVE balance:", revAmount.toString());
  console.log("STRK balance:", (Number(strkBalance) / 1e18).toFixed(4), "STRK");

  // === STEP 1: Transfer STRK using market session (exact same policies as market-buy.ts) ===
  if (strkBalance >= STRK_TRANSFER_AMOUNT) {
    console.log(`\n=== Step 1: Transferring 2000 STRK ===`);
    const marketSessionDir = "./public-data/runner/cartridge-session-market";

    // Must match market-buy.ts policies exactly for session to probe() successfully
    const marketProvider = new SessionProvider({
      rpc: config.chain.rpcUrl,
      chainId: CHAIN_ID_SN_MAIN,
      policies: {
        contracts: {
          [STRK_ADDRESS]: {
            methods: [{ name: "Transfer", entrypoint: "transfer" }],
          },
          [DEFAULT_ROUTER]: {
            methods: [
              { name: "Multihop Swap", entrypoint: "multihop_swap" },
              { name: "Multi Multihop Swap", entrypoint: "multi_multihop_swap" },
              { name: "Clear Minimum", entrypoint: "clear_minimum" },
              { name: "Clear", entrypoint: "clear" },
            ],
          },
        },
      },
      basePath: marketSessionDir,
    });

    let marketAccount = (await marketProvider.probe()) as any;
    if (!marketAccount) {
      console.log("Market session expired; opening browser for approval...");
      marketAccount = await marketProvider.connect();
    }
    console.log(`Market session account: ${marketAccount.address}`);

    const strkResult = await marketAccount.execute([{
      contractAddress: STRK_ADDRESS,
      entrypoint: "transfer",
      calldata: [SHALOMBRUDER, cairo.uint256(STRK_TRANSFER_AMOUNT)],
    }]);
    console.log("STRK TX:", strkResult.transaction_hash);
    console.log(`Voyager: https://voyager.online/tx/${strkResult.transaction_hash}`);
    console.log("Waiting for confirmation...");
    await provider.waitForTransaction(strkResult.transaction_hash);
    console.log("STRK transfer confirmed!");
  } else {
    console.log(`Skipping STRK: only ${(Number(strkBalance) / 1e18).toFixed(4)} available (need 2000)`);
  }

  // === STEP 2: Transfer potions using a dedicated potion-transfer session ===
  if (atkAmount > 0n || revAmount > 0n) {
    console.log(`\n=== Step 2: Transferring potions ===`);
    const potionSessionDir = "./public-data/runner/cartridge-session-potion-transfer";

    const potionContracts: Record<string, { methods: { name: string; entrypoint: string }[] }> = {};
    if (atkAmount > 0n) {
      potionContracts[attackAddr] = { methods: [{ name: "Transfer", entrypoint: "transfer" }] };
    }
    if (revAmount > 0n) {
      potionContracts[reviveAddr] = { methods: [{ name: "Transfer", entrypoint: "transfer" }] };
    }

    const potionProvider = new SessionProvider({
      rpc: config.chain.rpcUrl,
      chainId: CHAIN_ID_SN_MAIN,
      policies: { contracts: potionContracts },
      basePath: potionSessionDir,
    });

    let potionAccount = (await potionProvider.probe()) as any;
    if (!potionAccount) {
      console.log("No potion transfer session; opening browser for approval...");
      potionAccount = await potionProvider.connect();
    }
    console.log(`Potion session account: ${potionAccount.address}`);

    const potionCalls: any[] = [];
    if (atkAmount > 0n) {
      potionCalls.push({
        contractAddress: attackAddr,
        entrypoint: "transfer",
        calldata: [SHALOMBRUDER, cairo.uint256(atkAmount)],
      });
      console.log(`Will transfer ${atkAmount} ATTACK`);
    }
    if (revAmount > 0n) {
      potionCalls.push({
        contractAddress: reviveAddr,
        entrypoint: "transfer",
        calldata: [SHALOMBRUDER, cairo.uint256(revAmount)],
      });
      console.log(`Will transfer ${revAmount} REVIVE`);
    }

    const potionResult = await potionAccount.execute(potionCalls);
    console.log("Potion TX:", potionResult.transaction_hash);
    console.log(`Voyager: https://voyager.online/tx/${potionResult.transaction_hash}`);
    console.log("Waiting for confirmation...");
    await provider.waitForTransaction(potionResult.transaction_hash);
    console.log("Potion transfers confirmed!");
  }

  console.log("\n✓ All transfers to Shalombruder complete!");
}

main().catch((err) => {
  console.error("Transfer failed:", err);
  process.exit(1);
});
