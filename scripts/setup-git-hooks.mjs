#!/usr/bin/env node
import { execSync } from "node:child_process";

try {
  execSync("git rev-parse --is-inside-work-tree", { stdio: "ignore" });
  execSync("git config core.hooksPath .githooks", { stdio: "inherit" });
  console.log("Git hooks installed: core.hooksPath=.githooks");
  console.log("Pre-commit will run: npm run safety:public");
} catch (err) {
  console.error("Failed to install git hooks.", err);
  process.exit(1);
}
