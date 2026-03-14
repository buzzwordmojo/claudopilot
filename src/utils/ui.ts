import chalk from "chalk";
import ora, { type Ora } from "ora";

export const ui = {
  header(text: string) {
    console.log();
    console.log(chalk.bold.cyan(`  ${text}`));
    console.log(chalk.dim("  " + "─".repeat(text.length + 2)));
    console.log();
  },

  step(num: number, total: number, text: string) {
    console.log(
      chalk.dim(`  [${num}/${total}]`) + " " + chalk.white(text)
    );
  },

  success(text: string) {
    console.log(chalk.green(`  ✓ ${text}`));
  },

  warn(text: string) {
    console.log(chalk.yellow(`  ⚠ ${text}`));
  },

  error(text: string) {
    console.log(chalk.red(`  ✗ ${text}`));
  },

  info(text: string) {
    console.log(chalk.dim(`  ℹ ${text}`));
  },

  hint(lines: string[]) {
    console.log();
    for (const line of lines) {
      console.log(chalk.dim(`    ${line}`));
    }
    console.log();
  },

  checklist(title: string, items: { label: string; detail: string }[]) {
    console.log();
    console.log(chalk.bold.white(`  ${title}`));
    console.log(chalk.dim("  " + "─".repeat(title.length + 2)));
    for (const item of items) {
      console.log(chalk.yellow(`    □ ${item.label}`));
      console.log(chalk.dim(`      ${item.detail}`));
    }
    console.log();
  },

  blank() {
    console.log();
  },

  spinner(text: string): Ora {
    return ora({ text: `  ${text}`, color: "cyan" }).start();
  },

  banner() {
    console.log();
    console.log(
      chalk.bold.cyan("  claudopilot") +
        chalk.dim(" — AI-augmented SDLC")
    );
    console.log(
      chalk.dim(
        "  Self-driving planning, red team loops, and PM integration"
      )
    );
    console.log();
  },

  done() {
    console.log();
    console.log(
      chalk.bold.green("  Done!") +
        chalk.dim(" Run ") +
        chalk.white("claudopilot doctor") +
        chalk.dim(" to verify everything is connected.")
    );
    console.log();
  },
};
