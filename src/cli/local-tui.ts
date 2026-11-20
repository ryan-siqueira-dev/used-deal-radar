import { stdin, stdout } from "node:process";
import { LocalController } from "../local/controller.js";
import { runLocalMenu } from "../local/menu.js";

if (!stdin.isTTY || !stdout.isTTY) {
  console.error("Execute npm run tui diretamente em um terminal interativo.");
  process.exitCode = 1;
} else {
  try {
    await runLocalMenu(new LocalController(), stdin, stdout);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
