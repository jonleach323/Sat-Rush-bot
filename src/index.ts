/**
 * Orchestrator entrypoint. The round state machine lands in a later stage —
 * for now this boots config + logger so `pnpm dev` proves the scaffold.
 */
import { loadConfig, summarizeConfig } from "./config.js";
import { logger } from "./logger.js";

const cfg = loadConfig();
logger.info(summarizeConfig(cfg), "sat-rush strategy client — config loaded");

if (cfg.EXECUTION_MODE === "dry") {
  logger.info("EXECUTION_MODE=dry: transaction sending is disabled");
}

logger.warn("orchestrator not implemented yet (scaffold stage) — exiting");
