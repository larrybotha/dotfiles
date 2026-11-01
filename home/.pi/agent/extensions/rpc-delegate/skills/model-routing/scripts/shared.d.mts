export declare const TELEMETRY_SOURCE: string;
export declare const VISION_ARCHETYPE: string;
export declare const WEIGHTS_DOMAIN: ReadonlySet<string>;
export declare const PREFERENCE_DOMAIN: ReadonlySet<string>;
export declare const FALLBACK_DOMAIN: ReadonlySet<string>;
export declare const DEFAULT_ROUTING_POLICY: Readonly<{
	preference: string;
	fallback: string;
	minArtifactRows: number;
	maxBrokenRate: number;
	gateWindowDays: number;
}>;
export declare interface RoutingPolicy {
	preference: string;
	fallback: string;
	minArtifactRows: number;
	maxBrokenRate: number;
	gateWindowDays: number;
}
export declare interface TelemBucket {
	n: number;
	okTrue: number;
	okFalse: number;
	okNull: number;
	stall: number;
	failures: Record<string, number>;
	costSum: number;
	costN: number;
	runSum: number;
	runN: number;
}
export declare interface TelemStats {
	byModel: Map<string, TelemBucket>;
	byCell: Map<string, TelemBucket>;
	harnessFailures: number;
}
export declare interface CandidateGate {
	ok: boolean;
	reason: string;
}
export declare interface OrderedCandidate {
	id: string;
	open: boolean;
	gate: CandidateGate;
	tier: number;
	rank: number;
}
export declare function readJsonl(file: string): Promise<any[]>;
export declare function readJsonlSync(file: string): any[];
export declare function hardFilter(store: any, opts?: { minContext?: number | null; minOutput?: number | null; needsImage?: boolean }): string | null;
export declare function routingPolicy(roster: unknown): RoutingPolicy;
export declare function telemetryStats(rows: unknown[], opts?: { sinceMs?: number | null }): TelemStats;
export declare function telemetryStatsForPolicy(rows: unknown[], policy: RoutingPolicy): TelemStats;
export declare function qualityGate(stats: TelemBucket | undefined, policy: RoutingPolicy): CandidateGate;
export declare function pickFallback(input: {
	roster: any;
	verdicts: any;
	catalog: Map<string, { provider: string; store: any }>;
	telemetryRows?: any[];
	policy?: RoutingPolicy;
	archetype: string | null;
	currentModel: string | null;
	attempted?: Set<string>;
	needsImage?: boolean;
}): { provider: string; model: string } | null;
export declare function orderCandidates(
	ids: string[],
	opts: { meta?: Record<string, { weights?: string }>; stats?: TelemStats | null; policy: RoutingPolicy },
): OrderedCandidate[];
export declare function flattenCatalog(store: unknown): {
	map: Map<string, { id: string; provider: string; store: Record<string, any> }>;
	collisions: Array<{ id: string; providers: string[] }>;
};
export declare function expandTilde(p: string): string;
