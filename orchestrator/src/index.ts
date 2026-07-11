import { loadConfig } from './config.js';
import { runWard } from './fsm.js';

async function main(): Promise<void> {
  const cfg = loadConfig();
  const code = await runWard(cfg);
  process.exit(code);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
