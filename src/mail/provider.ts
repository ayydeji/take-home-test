export type MailMessage = {
	to: string;
	subject: string;
	body: string;
};

// A real provider (Resend, AWS SES, or the mock at src/providers/sendgrid.ts)
// would implement this interface behind `send`.
export interface MailProvider {
	send(message: MailMessage): Promise<void>;
}

export class FakeMail implements MailProvider {
	sent: MailMessage[] = [];
	private failing = false;
	private failure: Error = new Error("fake mail failure");

	fail(err?: Error): void {
		this.failing = true;
		if (err) {
			this.failure = err;
		}
	}

	heal(): void {
		this.failing = false;
	}

	async send(message: MailMessage): Promise<void> {
		this.sent.push(message);
		if (this.failing) {
			throw this.failure;
		}
	}
}

export class ConsoleMail implements MailProvider {
	async send(message: MailMessage): Promise<void> {
		console.log(`[mail] to=${message.to} subject=${message.subject}`);
	}
}
