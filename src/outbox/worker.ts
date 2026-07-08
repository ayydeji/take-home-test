import { sql } from "drizzle-orm";
import { Db } from "../db/client";
import { config } from "../config";
import { MailProvider } from "../mail/provider";

export type OutboxWorker = {
	start: () => void;
	stop: () => void;
	tick: (hooks?: TickHooks) => Promise<void>;
};

export type TickHooks = {
	onBeforeCommit?: () => void | Promise<void>;
};

type OutboxRow = {
	id: string;
	form_id: string;
	payload: { form_id: string; received_at: string };
};

export function createOutboxWorker(
	db: Db,
	deps: {
		mail: MailProvider;
		intervalMs?: number;
		backoffBaseMs?: number;
		backoffCapMs?: number;
	},
): OutboxWorker {
	const intervalMs = deps.intervalMs ?? config.outbox.intervalMs;
	const backoffBaseMs = deps.backoffBaseMs ?? config.outbox.backoffBaseMs;
	const backoffCapMs = deps.backoffCapMs ?? config.outbox.backoffCapMs;

	let running = false;
	let timer: NodeJS.Timeout | undefined;

	async function tick(hooks: TickHooks = {}): Promise<void> {
		await db.orm.transaction(async (tx) => {
			const claimed = await tx.execute<OutboxRow>(sql`
				select id, form_id, payload from outbox
				where status = 'pending' and next_attempt_at <= now()
				order by next_attempt_at
				for update skip locked
				limit 10
			`);

			for (const row of claimed.rows) {
				const message = {
					to: "happyforms@bots.com",
					subject: `Form ${row.payload.form_id} ready`,
					body: `Form ${row.payload.form_id} received at ${row.payload.received_at} is ready for dispatch.`,
				};

				try {
					await deps.mail.send(message);
					await tx.execute(sql`
						update outbox set status = 'sent', sent_at = now() where id = ${row.id}
					`);
				} catch {
					await tx.execute(sql`
						update outbox
						set attempts = attempts + 1,
							next_attempt_at = now() + (
								least(${backoffCapMs}, ${backoffBaseMs} * power(2, attempts))
								+ random() * ${backoffBaseMs}
							) * interval '1 millisecond'
						where id = ${row.id}
					`);
				}
			}

			await hooks.onBeforeCommit?.();
		});
	}

	function scheduleNext(): void {
		if (!running) {
			return;
		}
		timer = setTimeout(async () => {
			try {
				await tick();
			} catch {
				// A crashed tick must not kill the loop; the next tick retries.
			}
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

	return { start, stop, tick };
}
