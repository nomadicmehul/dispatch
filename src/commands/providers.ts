import { Command } from "commander";
import chalk from "chalk";
import { loadConfig } from "../utils/config.js";
import { log } from "../utils/logger.js";

export function registerProvidersCommand(program: Command) {
  program
    .command("providers")
    .description("Show detected AI providers and model routing configuration")
    .action(async () => {
      try {
        const cwd = process.cwd();
        const config = await loadConfig(cwd);

        const { getDetectedProvidersSummary, ModelRouter, MODEL_REGISTRY } = await import("../router/index.js");
        const providers = getDetectedProvidersSummary();

        console.log();
        console.log(chalk.bold("  Detected AI Providers:"));
        console.log();

        for (const p of providers) {
          const icon = p.available ? chalk.green("  +") : chalk.red("  -");
          const name = p.provider.padEnd(16);
          const reason = chalk.gray(p.reason || "");
          console.log(`${icon} ${chalk.bold(name)} ${reason}`);
        }

        const available = providers.filter((p) => p.available);
        if (available.length === 0) {
          console.log();
          console.log(chalk.yellow("  No providers detected. Set at least one API key:"));
          console.log(chalk.gray("    ANTHROPIC_API_KEY, GEMINI_API_KEY, GITHUB_TOKEN, or OPENAI_API_KEY"));
          console.log();
          return;
        }

        // Show model routing
        console.log();
        console.log(chalk.bold(`  Model Routing (strategy: ${config.routingStrategy}):`));
        console.log();

        try {
          const router = new ModelRouter({
            strategy: config.routingStrategy as any,
            preferredProvider: config.provider !== "auto" ? config.provider as any : undefined,
          });

          const phases = ["classify", "solve", "score", "create-issue"] as const;
          for (const phase of phases) {
            const model = router.getModelForPhase(phase);
            const estCost = phase === "solve"
              ? (50_000 / 1_000_000 * model.inputCostPer1M + 5_000 / 1_000_000 * model.outputCostPer1M)
              : (2_000 / 1_000_000 * model.inputCostPer1M + 200 / 1_000_000 * model.outputCostPer1M);

            console.log(
              `    ${chalk.cyan(phase.padEnd(14))} ${chalk.white(model.displayName.padEnd(30))} ` +
              `${chalk.gray(`~$${estCost.toFixed(4)}/call`)}`
            );
          }
        } catch (err) {
          console.log(chalk.yellow(`    Could not initialize router: ${err instanceof Error ? err.message : err}`));
        }

        // Show registered models
        console.log();
        console.log(chalk.bold("  Registered Models:"));
        console.log();

        const byProvider = new Map<string, typeof MODEL_REGISTRY>();
        for (const model of MODEL_REGISTRY) {
          const list = byProvider.get(model.provider) || [];
          list.push(model);
          byProvider.set(model.provider, list);
        }

        for (const [provider, models] of byProvider) {
          const isAvailable = providers.find((p) => p.provider === provider)?.available;
          const status = isAvailable ? chalk.green("[available]") : chalk.gray("[no key]");
          console.log(`    ${chalk.bold(provider)} ${status}`);
          for (const model of models) {
            const costStr = model.inputCostPer1M > 0
              ? `$${model.inputCostPer1M}/$${model.outputCostPer1M} per 1M tokens`
              : "free tier";
            console.log(`      ${model.displayName.padEnd(28)} ${chalk.gray(costStr)}`);
          }
        }

        console.log();
      } catch (err) {
        log.error(`Providers check failed: ${err instanceof Error ? err.message : err}`);
        process.exit(1);
      }
    });
}
