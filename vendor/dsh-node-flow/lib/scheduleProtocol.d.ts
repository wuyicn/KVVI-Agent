/**
 * Strict cron and timezone helpers shared by the scheduler, publish validation,
 * and schedule views. Schedules deliberately use five fields only:
 * minute, hour, day-of-month, month, and day-of-week.
 */
export type ScheduleDateParts = {
    year: number;
    month: number;
    day: number;
    hour: number;
    minute: number;
    dayOfWeek: number;
};
type CronField = {
    values: readonly number[];
    includes(value: number): boolean;
};
type ParsedCronExpression = {
    normalized: string;
    minute: CronField;
    hour: CronField;
    day: CronField;
    month: CronField;
    dayOfWeek: CronField;
};
/** Parse and normalize a strict five-field cron expression. */
export declare function parseCronExpression(value: unknown): ParsedCronExpression;
export declare function normalizeCronExpression(value: unknown): string;
/**
 * Normalize a configured IANA timezone. Empty values intentionally remain
 * undefined so legacy schedules continue using the host's local timezone.
 */
export declare function normalizeScheduleTimezone(value: unknown): string | undefined;
export declare function validateScheduleConfiguration(cron: unknown, timezone?: unknown): {
    cron: string;
    timezone?: string;
};
export declare function hostScheduleTimezone(): string;
export declare function formatScheduleTimezone(timezone?: string): string;
/** Read a Date as wall-clock components in the configured or host-local zone. */
export declare function scheduleDateParts(date: Date, timezone?: string): ScheduleDateParts;
/** True when a cron expression matches this instant in its configured zone. */
export declare function cronMatchesSchedule(cron: string, date: Date, timezone?: string): boolean;
/** A stable wall-clock minute key used to suppress duplicate DST fall-back runs. */
export declare function scheduleWallClockKey(date: Date, timezone?: string): string;
/** Existing persisted schedules use this UTC minute key; retain it for compatibility. */
export declare function scheduleInstantMinuteKey(date: Date): string;
/** Format an instant as an unambiguous, compact wall-clock value in a schedule's zone. */
export declare function formatScheduleTime(value: Date | string | undefined, timezone?: string): string | undefined;
/**
 * Find the next scheduled instant after `from`. Spring-forward gaps have no
 * corresponding instant and are skipped. When `skipWallClockKey` is provided,
 * both instances of an autumn fall-back wall-clock minute are skipped.
 */
export declare function nextScheduleFire(cronValue: string, from: Date, timezone?: string, skipWallClockKey?: string): Date | null;
export {};
