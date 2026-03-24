import fs from "fs";
import path from "path";

const root = path.resolve(process.cwd(), "src");
const target = path.join(root, "extension.js");

if (!fs.existsSync(target)) {
  console.error("Missing src/extension.js");
  process.exit(1);
}

const code = fs.readFileSync(target, "utf8");

if (!code.includes("registerCommand")) {
  console.error("Expected a registered command in extension.js");
  process.exit(1);
}

console.log("Lint check passed.");
