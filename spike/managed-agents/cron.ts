// ── Delay parsing ───────────────────────────────────────────────────

const UNITS: Record<string, number> = { h: 3_600_000, m: 60_000, s: 1_000 };

export function parseDelay(s: string): number {
  const match = s.trim().match(/^(\d+)\s*(h|m|s)$/i);
  if (!match) throw new Error(`Bad delay format: "${s}" (use e.g. "24h", "30m", "90s")`);
  const ms = Number(match[1]) * UNITS[match[2].toLowerCase()];
  if (ms < 60_000) throw new Error("Delay must be >= 1m");
  if (ms > 7 * 86_400_000) throw new Error("Delay must be <= 7d");
  return ms;
}

// ── Timer state ─────────────────────────────────────────────────────

type ProcessEventFn = (sessionId: string, message: string) => Promise<void>;

const timers = new Map<string, Timer>();
let seq = 0;

// ── Handler ─────────────────────────────────────────────────────────

export function handleCronTool(
  sessionId: string,
  input: { delay?: string },
  processEvent: ProcessEventFn,
): string {
  if (!input.delay) return "Error: 'delay' is required (e.g. \"24h\", \"30m\").";

  let ms: number;
  try {
    ms = parseDelay(input.delay);
  } catch (e: unknown) {
    return `Error: ${(e as Error).message}`;
  }

  const cronId = `cron_${++seq}`;
  const firesAt = new Date(Date.now() + ms).toISOString();

  const timer = setTimeout(async () => {
    try {
      await processEvent(
        sessionId,
        `Cron check-in (${cronId}) fired.\nAssess current ticket state and determine if intervention is needed.`,
      );
    } catch (err) {
      console.error(`  !! cron ${cronId} fire failed:`, err);
    } finally {
      timers.delete(cronId);
    }
  }, ms);

  timers.set(cronId, timer);
  console.log(`  ⏱ ${cronId}: fires in ${input.delay} (${firesAt})`);
  return `Scheduled ${cronId}. Fires at ${firesAt} (in ${input.delay}).`;
}
