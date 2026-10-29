/**
 * Shared plumbing for the wiring deploy scripts (02e_wire_vesting, 09_wire_all):
 * idempotent transaction steps and a retrying on-chain verification pass.
 */

type Log = (...args: any[]) => void;

export type Check = [label: string, ok: () => Promise<boolean>];

/** Case-insensitive address equality. */
export const eq = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/**
 * Build a `step` runner: each step is skipped when `isDone()` already holds,
 * otherwise `run()` sends one transaction and waits `confirmations`.
 */
export function createStepper(log: Log, confirmations: number) {
  const stats = { sent: 0, skipped: 0 };

  const step = async (
    label: string,
    isDone: () => Promise<boolean>,
    run: () => Promise<any>,
  ) => {
    if (await isDone()) {
      log(`  ✓ ${label} — already set, skipped`);
      stats.skipped++;
      return;
    }
    const tx = await run();
    const receipt = await tx.wait(confirmations);
    log(`  → ${label} — tx ${receipt?.hash}`);
    stats.sent++;
  };

  return { step, stats };
}

// Public BSC RPCs are load-balanced; a read right after the last tx can hit a
// node that has not seen the block yet. Re-read a few times before failing.
const VERIFY_RETRIES = 5;
const VERIFY_DELAY_MS = 3000;

/**
 * Re-read every check from chain. Any mismatch means the deploy is NOT usable —
 * throw rather than log a summary.
 */
export async function verifyChecks(log: Log, checks: Check[]): Promise<void> {
  log(`\n  verifying wiring on chain...`);
  const failed: string[] = [];
  for (const [label, ok] of checks) {
    let pass = await ok();
    for (let i = 1; !pass && i < VERIFY_RETRIES; i++) {
      await new Promise((r) => setTimeout(r, VERIFY_DELAY_MS));
      pass = await ok();
    }
    log(`  ${pass ? "✓" : "✗"} ${label}`);
    if (!pass) failed.push(label);
  }
  if (failed.length) {
    throw new Error(`wiring incomplete — ${failed.length} check(s) failed:\n  - ${failed.join("\n  - ")}`);
  }
}
