/**
 * `shannon status` command — show running scans and Temporal health.
 */

import { isTemporalReady, listRunningWorkers } from "../docker.js";

export function status(): void {
  // 1. Temporal health
  const temporalUp = isTemporalReady();
  console.info(`Temporal: ${temporalUp ? "running" : "not running"}`);
  if (temporalUp) {
    console.info("  Dashboard: http://localhost:8233");
  }
  console.info("");

  // 2. Running scans
  const workers = listRunningWorkers();
  if (workers) {
    console.info("Running scans:");
    console.info(workers);
  } else {
    console.info("No scans running");
  }
}
