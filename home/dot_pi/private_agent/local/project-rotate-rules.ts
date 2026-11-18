export interface RotationThresholds {
	sizeMB: number;
	compactions: number;
	days: number;
}

export function rotationDue(
	thresholds: RotationThresholds,
	stats: { bytes: number; compactions: number; startedAt: number },
	now = Date.now(),
): boolean {
	return stats.bytes >= thresholds.sizeMB * 1024 * 1024
		|| stats.compactions >= thresholds.compactions
		|| now - stats.startedAt >= thresholds.days * 86400000;
}

export function rotationThresholds(defaults: RotationThresholds, overrides: Partial<RotationThresholds> = {}): RotationThresholds {
	const thresholds = { ...defaults, ...overrides };
	for (const value of Object.values(thresholds)) {
		if (!Number.isFinite(value) || value <= 0) throw new Error("Rotation thresholds must be positive numbers");
	}
	return thresholds;
}
