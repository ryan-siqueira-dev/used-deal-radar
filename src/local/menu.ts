import { createInterface } from "node:readline/promises";
import type { Readable, Writable } from "node:stream";
import type { LocalController } from "./controller.js";

type MenuController = Pick<LocalController, "status" | "start" | "openDashboard" | "logs" | "stop">;

const STATE_LABELS = {
  running: "Em execução",
  stopped: "Parado",
  partial: "Parcial",
  unavailable: "Indisponível",
} as const;

const OPTIONS = [
  "  1  Iniciar",
  "  2  Abrir painel",
  "  3  Ver logs",
  "  4  Parar",
  "  0  Sair",
].join("\n");

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function runLocalMenu(controller: MenuController, input: Readable, output: Writable): Promise<void> {
  const terminal = createInterface({ input, output, terminal: true, historySize: 0 });
  const closed = new AbortController();
  let logFollower: AbortController | undefined;
  const handleTermination = () => terminal.close();
  const handleInterrupt = () => {
    if (logFollower) {
      logFollower.abort();
    } else {
      output.write("\n");
      terminal.close();
    }
  };

  terminal.once("close", () => {
    closed.abort();
    logFollower?.abort();
  });
  // Readline receives Ctrl+C in raw mode. SIGINT can also target the process directly.
  terminal.on("SIGINT", handleInterrupt);
  process.on("SIGINT", handleInterrupt);
  process.on("SIGHUP", handleTermination);
  process.on("SIGTERM", handleTermination);

  try {
    output.write("Used Deal Radar local\n");

    while (!closed.signal.aborted) {
      try {
        const status = await controller.status(closed.signal);
        if (closed.signal.aborted) break;
        output.write(`\nEstado — ${STATE_LABELS[status.state]}\n${status.message}\nPainel — ${status.url}\n`);
      } catch (error) {
        if (closed.signal.aborted) break;
        output.write(`\nEstado — Indisponível\n${errorMessage(error)}\n`);
      }

      output.write(`\n${OPTIONS}\n\n`);
      const choice = (await terminal.question("Opção (Enter para confirmar) > ", { signal: closed.signal })).trim();
      if (choice === "0" || closed.signal.aborted) break;

      try {
        switch (choice) {
          case "1":
            output.write("Iniciando o app local. Aguarde o banco e o painel ficarem prontos.\n");
            await controller.start(closed.signal);
            break;
          case "2":
            output.write("Abrindo o painel no navegador.\n");
            await controller.openDashboard(closed.signal);
            break;
          case "3":
            logFollower = new AbortController();
            output.write("Acompanhando os logs. Pressione Ctrl+C para voltar ao menu.\n");
            await controller.logs(logFollower.signal);
            break;
          case "4":
            output.write("Parando o app local.\n");
            await controller.stop(closed.signal);
            break;
          default:
            output.write("Opção inválida.\n");
        }
      } catch (error) {
        if (!closed.signal.aborted) output.write(`Falha na operação. ${errorMessage(error)}\n`);
      } finally {
        logFollower = undefined;
      }
    }
  } catch (error) {
    if (!closed.signal.aborted) throw error;
  } finally {
    process.removeListener("SIGINT", handleInterrupt);
    process.removeListener("SIGHUP", handleTermination);
    process.removeListener("SIGTERM", handleTermination);
    terminal.close();
  }
}
