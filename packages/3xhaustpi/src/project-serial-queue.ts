export class ProjectSerialQueue {
	private readonly tails = new Map<string, Promise<void>>();

	run<T>(projectRoot: string, operation: () => Promise<T>): Promise<T> {
		const previous = this.tails.get(projectRoot) ?? Promise.resolve();
		const task = previous.catch(() => undefined).then(operation);
		const tail = task.then(
			() => undefined,
			() => undefined,
		);
		this.tails.set(projectRoot, tail);
		void tail.finally(() => {
			if (this.tails.get(projectRoot) === tail) this.tails.delete(projectRoot);
		});
		return task;
	}

	async idle(): Promise<void> {
		await Promise.all(this.tails.values());
	}
}
