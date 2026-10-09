// Memory safety and presentation adapter: model-facing content and dedupe/persistence details are untouched.
type MemoryMessage = { customType?: string; display?: boolean; details?: { degraded?: unknown; error?: unknown } };
export function quietMessage<T extends MemoryMessage>(message: T): T {
	if (!["memini-recall", "memini-briefing"].includes(message.customType ?? "") || message.details?.degraded || message.details?.error) return message;
	return { ...message, display: false };
}

// Proxy only the package's own emissions, not other extensions or global Pi behavior.
export function quietMemoryAPI<T extends object>(api: T): T {
	const blocked = () => (globalThis as any)[Symbol.for("pi-profile.memory-block")];
	return new Proxy(api, {
		get(target, key, receiver) {
			const original: any = Reflect.get(target, key, receiver);
			if (key === "sendMessage") return (message: MemoryMessage, ...args: unknown[]) => blocked() ? undefined : original.call(target, quietMessage(message), ...args);
			if (key === "on") return (event: string, handler: (...args: any[]) => any) => original.call(target, event,
				(...args: any[]) => {
					if (blocked()) return undefined;
					if (event !== "before_agent_start") return handler(...args);
					return Promise.resolve().then(() => handler(...args)).then(result =>
						result?.message ? { ...result, message: quietMessage(result.message) } : result);
				});
			return original;
		},
	});
}
