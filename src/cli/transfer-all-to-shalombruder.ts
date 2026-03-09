#!/usr/bin/env tsx

import SessionProvider from "@cartridge/controller/session/node";
import { Contract, RpcProvider, cairo } from "starknet";
import { loadConfig } from "../config.js";
import { loadSummitAbi } from "../chain/abi.js";

const SHALOMBRUDER = "0x00Df433279d2EeA7F73e8bdFBCE78931Ac768BF77fcE7d319149a7FD367D59a7";
const SALOMONDAY = "0x17dc36e56a09b8b4a78b3dc934f216eb97cb0a326944cf5717b328f249cbce4";
const CHAIN_ID_SN_MAIN = "0x534e5f4d41494e";

const TOKEN_GETTERS = [
  { name: "ATTACK", getter: "get_attack_potion_address" },
  { name: "REVIVE", getter: "get_revive_potion_address" },
  { name: "EXTRA LIFE", getter: "get_extra_life_potion_address" },
  { name: "POISON", getter: "get_poison_potion_address" },
  { name: "SKULL", getter: "get_skull_token_address" },
  { name: "CORPSE", getter: "get_corpse_token_address" },
];

const erc20Abi = [
  { name: "balanceOf", type: "function", inputs: [{ name: "account", type: "core::starknet::contract_address::ContractAddress" }], outputs: [{ type: "core::integer::u256" }], state_mutability: "view" },
  { name: "transfer", type: "function", inputs: [{ name: "recipient", type: "core::starknet::contract_address::ContractAddress" }, { name: "amount", type: "core::integer::u256" }], outputs: [{ type: "core::bool" }], state_mutability: "external" },
];

async function main() {
  const config = loadConfig("public-config/runner.json");
  const provider = new RpcProvider({ nodeUrl: config.chain.rpcUrl, blockIdentifier: "latest" });
  const abi = await loadSummitAbi(config.chain.rpcUrl, config.chain.summitContract);
  const contract = new Contract(abi, config.chain.summitContract, provider);

  // Discover all token addresses
  const tokens: { name: string; address: string; balance: bigint }[] = [];
  for (const { name, getter } of TOKEN_GETTERS) {
    try {
      const raw = await contract.call(getter, []);
      const addr = "0x" + BigInt(raw as any).toString(16);
      const token = new Contract(erc20Abi, addr, provider);
      const bal = BigInt(await token.call("balanceOf", [SALOMONDAY]) as any);
      tokens.push({ name, address: addr, balance: bal });
      console.log(`${name}: ${bal.toString()} (${addr})`);
    } catch (e) {
      console.log(`${name}: skipped (getter not available)`);
    }
  }

  const toTransfer = tokens.filter(t => t.balance > 0n);
  if (toTransfer.length === 0) {
    console.log("\nNo potions to transfer from salomonday.");
    return;
  }

  console.log(`\n${toTransfer.length} tokens to transfer to Shalombruder:`);
  for (const t of toTransfer) {
    console.log(`  ${t.name}: ${t.balance.toString()}`);
  }

  // Build policies for all tokens we need to transfer
  const contracts: Record<string, { methods: { name: string; entrypoint: string }[] }> = {};
  for (const t of toTransfer) {
    contracts[t.address] = { methods: [{ name: "Transfer", entrypoint: "transfer" }] };
  }

  const sessionDir = "./public-data/runner/cartridge-session-transfer-all";
  const sessionProvider = new SessionProvider({
    rpc: config.chain.rpcUrl,
    chainId: CHAIN_ID_SN_MAIN,
    policies: { contracts },
    basePath: sessionDir,
  });

  let account = (await sessionProvider.probe()) as any;
  if (!account) {
    console.log("\n>>> APPROVE THE SESSION IN YOUR BROWSER NOW (5 min timeout) <<<\n");
    account = await sessionProvider.connect();
  }
  console.log(`Session account: ${account.address}`);

  // Build multicall
  const calls = toTransfer.map(t => ({
    contractAddress: t.address,
    entrypoint: "transfer",
    calldata: [SHALOMBRUDER, cairo.uint256(t.balance)],
  }));

  console.log(`\nExecuting ${calls.length} transfers in one multicall...`);
  const result = await account.execute(calls);
  console.log("TX:", result.transaction_hash);
  console.log(`Voyager: https://voyager.online/tx/${result.transaction_hash}`);
  console.log("Waiting for confirmation...");
  await provider.waitForTransaction(result.transaction_hash);
  console.log("\nAll potions transferred to Shalombruder!");
}

main().catch((err) => {
  console.error("Transfer failed:", err);
  process.exit(1);
});
