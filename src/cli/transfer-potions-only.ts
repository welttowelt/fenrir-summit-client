#!/usr/bin/env tsx

import SessionProvider from "@cartridge/controller/session/node";
import { Contract, RpcProvider, cairo } from "starknet";
import { loadConfig } from "../config.js";
import { loadSummitAbi } from "../chain/abi.js";

const SHALOMBRUDER = "0x00Df433279d2EeA7F73e8bdFBCE78931Ac768BF77fcE7d319149a7FD367D59a7";
const CHAIN_ID_SN_MAIN = "0x534e5f4d41494e";

async function main() {
  const config = loadConfig("public-config/runner.json");
  const provider = new RpcProvider({ nodeUrl: config.chain.rpcUrl, blockIdentifier: "latest" });
  const abi = await loadSummitAbi(config.chain.rpcUrl, config.chain.summitContract);
  const contract = new Contract(abi, config.chain.summitContract, provider);

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

  const atkAmount = BigInt(await attackToken.call("balanceOf", [config.account.controllerAddress]) as any);
  const revAmount = BigInt(await reviveToken.call("balanceOf", [config.account.controllerAddress]) as any);
  console.log("ATTACK balance:", atkAmount.toString());
  console.log("REVIVE balance:", revAmount.toString());

  if (atkAmount === 0n && revAmount === 0n) {
    console.log("No potions to transfer.");
    return;
  }

  const potionSessionDir = "./public-data/runner/cartridge-session-potion-transfer";
  const potionContracts: Record<string, { methods: { name: string; entrypoint: string }[] }> = {};
  if (atkAmount > 0n) potionContracts[attackAddr] = { methods: [{ name: "Transfer", entrypoint: "transfer" }] };
  if (revAmount > 0n) potionContracts[reviveAddr] = { methods: [{ name: "Transfer", entrypoint: "transfer" }] };

  const potionProvider = new SessionProvider({
    rpc: config.chain.rpcUrl,
    chainId: CHAIN_ID_SN_MAIN,
    policies: { contracts: potionContracts },
    basePath: potionSessionDir,
  });

  let potionAccount = (await potionProvider.probe()) as any;
  if (!potionAccount) {
    console.log("\n>>> APPROVE THIS IN YOUR BROWSER NOW (you have 5 minutes) <<<\n");
    potionAccount = await potionProvider.connect();
  }
  console.log(`Using account: ${potionAccount.address}`);

  const potionCalls: any[] = [];
  if (atkAmount > 0n) {
    potionCalls.push({ contractAddress: attackAddr, entrypoint: "transfer", calldata: [SHALOMBRUDER, cairo.uint256(atkAmount)] });
    console.log(`Transferring ${atkAmount} ATTACK to Shalombruder...`);
  }
  if (revAmount > 0n) {
    potionCalls.push({ contractAddress: reviveAddr, entrypoint: "transfer", calldata: [SHALOMBRUDER, cairo.uint256(revAmount)] });
    console.log(`Transferring ${revAmount} REVIVE to Shalombruder...`);
  }

  const result = await potionAccount.execute(potionCalls);
  console.log("TX:", result.transaction_hash);
  console.log(`Voyager: https://voyager.online/tx/${result.transaction_hash}`);
  console.log("Waiting for confirmation...");
  await provider.waitForTransaction(result.transaction_hash);
  console.log("Potion transfers confirmed! ✓");
}

main().catch((err) => {
  console.error("Transfer failed:", err);
  process.exit(1);
});
