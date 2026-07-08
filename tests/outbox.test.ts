import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startTestDb, TestDb } from "./helpers/testDb";
import { createOutboxWorker } from "../src/outbox/worker";
import { FakeMail } from "../src/mail/provider";
import validForm from "./fixtures/valid-form.json";

const PII_MARKER = validForm.date_of_birth;

let ctx: TestDb;

beforeAll(async () => {
	ctx = await startTestDb();
});

afterAll(async () => {
	await ctx.stop();
});

async function insertPendingOutbox(contentHash: string) {
	const form = await ctx.db.pool.query(
		"insert into forms (content_hash, raw_payload, status) values ($1, $2, 'READY') returning id, received_at",
		[contentHash, JSON.stringify(validForm)],
	);
	const formId = form.rows[0].id as string;
	const receivedAt = new Date(form.rows[0].received_at).toISOString();

	const outbox = await ctx.db.pool.query(
		`insert into outbox (form_id, type, payload)
		 values ($1, 'form_ready_email', $2)
		 returning id`,
		[formId, JSON.stringify({ form_id: formId, received_at: receivedAt })],
	);

	return { formId, outboxId: outbox.rows[0].id as string };
}

function loadOutbox(id: string) {
	return ctx.db.pool
		.query(
			"select status, attempts, next_attempt_at, sent_at from outbox where id = $1",
			[id],
		)
		.then((result) => result.rows[0]);
}

describe("outbox worker", () => {
	it("sends one pending row on one tick, body has the form id and no PII", async () => {
		const { formId, outboxId } = await insertPendingOutbox(
			"outbox-success-hash",
		);
		const mail = new FakeMail();
		const worker = createOutboxWorker(ctx.db, { mail });

		await worker.tick();

		expect(mail.sent).toHaveLength(1);
		expect(mail.sent[0].to).toBe("happyforms@bots.com");
		expect(mail.sent[0].body).toContain(formId);
		expect(JSON.stringify(mail.sent[0])).not.toContain(PII_MARKER);
		expect(JSON.stringify(mail.sent[0])).not.toContain(validForm.name);

		const row = await loadOutbox(outboxId);
		expect(row.status).toBe("sent");
		expect(row.sent_at).not.toBeNull();
	});

	it("increments attempts and schedules the future on a failing mailer, then sends once healed", async () => {
		const { outboxId } = await insertPendingOutbox("outbox-fail-hash");
		const mail = new FakeMail();
		mail.fail();
		const worker = createOutboxWorker(ctx.db, {
			mail,
			backoffBaseMs: 60_000,
			backoffCapMs: 300_000,
		});

		await worker.tick();

		const afterFailure = await loadOutbox(outboxId);
		expect(afterFailure.status).toBe("pending");
		expect(afterFailure.attempts).toBe(1);
		expect(afterFailure.sent_at).toBeNull();
		expect(new Date(afterFailure.next_attempt_at).getTime()).toBeGreaterThan(
			Date.now(),
		);

		mail.heal();
		await ctx.db.pool.query(
			"update outbox set next_attempt_at = now() where id = $1",
			[outboxId],
		);

		await worker.tick();

		const afterHeal = await loadOutbox(outboxId);
		expect(afterHeal.status).toBe("sent");
	});

	it("rolls back atomically on a crash, losing nothing; a later tick sends successfully", async () => {
		const { outboxId } = await insertPendingOutbox("outbox-crash-hash");
		const mail = new FakeMail();
		mail.fail();
		const worker = createOutboxWorker(ctx.db, { mail });

		await expect(
			worker.tick({
				onBeforeCommit: () => {
					throw new Error("simulated crash before commit");
				},
			}),
		).rejects.toThrow("simulated crash before commit");

		const afterCrash = await loadOutbox(outboxId);
		expect(afterCrash.status).toBe("pending");
		expect(afterCrash.attempts).toBe(0);
		expect(afterCrash.sent_at).toBeNull();

		mail.heal();
		await worker.tick();

		const afterRecover = await loadOutbox(outboxId);
		expect(afterRecover.status).toBe("sent");
	});

	it("two concurrent ticks over one pending row result in exactly one send", async () => {
		const { outboxId } = await insertPendingOutbox("outbox-concurrent-hash");
		const mail = new FakeMail();
		const worker = createOutboxWorker(ctx.db, { mail });

		await Promise.all([worker.tick(), worker.tick()]);

		expect(mail.sent).toHaveLength(1);
		const row = await loadOutbox(outboxId);
		expect(row.status).toBe("sent");
	});

	it("start/stop is graceful and idempotent", () => {
		const worker = createOutboxWorker(ctx.db, {
			mail: new FakeMail(),
			intervalMs: 50,
		});

		expect(() => {
			worker.start();
			worker.stop();
			worker.stop();
		}).not.toThrow();
	});
});
