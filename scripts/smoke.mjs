import fs from "fs";
import path from "path";

const root = process.cwd();
const manifest = path.join(root, "package.json");

if (!fs.existsSync(manifest)) {
  console.error("Missing package.json");
  process.exit(1);
}

const pkg = JSON.parse(fs.readFileSync(manifest, "utf8"));

if (!pkg.contributes || !Array.isArray(pkg.contributes.commands)) {
  console.error("Missing contributes.commands in package.json");
  process.exit(1);
}

const hasCommand = pkg.contributes.commands.some(
  (item) => item.command === "i18nAssistant.extractToDictionary",
);

if (!hasCommand) {
  console.error("Command i18nAssistant.extractToDictionary is not declared.");
  process.exit(1);
}

console.log("Smoke check passed.");
