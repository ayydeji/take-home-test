import { sql } from "drizzle-orm";
import { Db } from "../db/client";
import { config } from "../config";
import { PipelineRunner } from "./run";

export type Sweeper = {
	start: () => void;
	stop: () => void;
	sweepOnce: () => Promise<void>;
};

export function createSweeper(
	db: Db,
	deps: { runner: PipelineRunner; intervalMs?: number; stalenessMs?: number },
): Sweeper {
	const intervalMs = deps.intervalMs ?? config.sweeper.intervalMs;
	const stalenessMs = deps.stalenessMs ?? config.sweeper.stalenessMs;

	let running = false;
	let timer: NodeJS.Timeout | undefined;

	async function sweepOnce(): Promise<void> {
		const stale = await db.orm.execute<{ id: string }>(sql`
			select id from forms
			where status in ('RECEIVED', 'VALIDATED', 'GEOCODED')
			and updated_at < now() - (${stalenessMs} * interval '1 millisecond')
			order by updated_at asc
		`);

		for (const row of stale.rows) {
			try {
				await deps.runner(row.id);
			} catch {
				// One bad form must not abort the tick; the next sweep retries it.
			}
		}
	}

	function scheduleNext(): void {
		if (!running) {
			return;
		}
		timer = setTimeout(async () => {
			await sweepOnce();
			scheduleNext();
		}, intervalMs);
	}

	function start(): void {
		if (running) {
			return;
		}
		running = true;
		scheduleNext();
	}

	function stop(): void {
		running = false;
		if (timer) {
			clearTimeout(timer);
			timer = undefined;
		}
	}

	return { start, stop, sweepOnce };
}
