export declare const FAILURE_CLASSES: readonly string[];
export declare const CLASS_DETECTION: Readonly<Record<string, string>>;
export declare const PROBE_PATTERNS: Readonly<Record<string, readonly string[]>>;
export declare interface DelegationPattern {
	readonly cls: string;
	readonly pattern: RegExp;
}
export declare const DELEGATION_PATTERNS: readonly DelegationPattern[];
export declare const PROBE_SAMPLES: Readonly<Record<string, readonly string[]>>;
export declare const DELEGATION_SAMPLES: Readonly<Record<string, readonly string[]>>;
