/**
 * Strict cron and timezone helpers shared by the scheduler, publish validation,
 * and schedule views. Schedules deliberately use five fields only:
 * minute, hour, day-of-month, month, and day-of-week.
 */
const CRON_FIELD_SPECS = [
    { label: '分', min: 0, max: 59 },
    { label: '时', min: 0, max: 23 },
    { label: '日', min: 1, max: 31 },
    { label: '月', min: 1, max: 12 },
    { label: '周', min: 0, max: 6 },
];
const zonedFormatterCache = new Map();
function parseCronInteger(value, label) {
    if (!/^\d+$/.test(value))
        throw new Error(`Cron ${label}字段包含非法值“${value}”`);
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed))
        throw new Error(`Cron ${label}字段包含非法值“${value}”`);
    return parsed;
}
function parseCronField(value, label, min, max) {
    if (!value)
        throw new Error(`Cron ${label}字段不能为空`);
    const values = new Set();
    for (const segment of value.split(',')) {
        if (!segment)
            throw new Error(`Cron ${label}字段包含空列表项`);
        const match = /^(\*|\d+)(?:-(\d+))?(?:\/(\d+))?$/.exec(segment);
        if (!match)
            throw new Error(`Cron ${label}字段格式无效：“${segment}”`);
        const source = match[1];
        const rangeEnd = match[2];
        const stepText = match[3];
        const start = source === '*' ? min : parseCronInteger(source, label);
        const end = rangeEnd === undefined
            ? stepText === undefined || source === '*' ? (source === '*' ? max : start) : max
            : parseCronInteger(rangeEnd, label);
        const step = stepText === undefined ? 1 : parseCronInteger(stepText, label);
        if (start < min || start > max || end < min || end > max || start > end) {
            throw new Error(`Cron ${label}字段必须在 ${min}-${max} 范围内`);
        }
        if (step < 1 || step > end - start + 1)
            throw new Error(`Cron ${label}字段的步长无效`);
        for (let current = start; current <= end; current += step)
            values.add(current);
    }
    if (values.size === 0)
        throw new Error(`Cron ${label}字段没有可用值`);
    const sorted = [...values].sort((left, right) => left - right);
    const accepted = new Set(sorted);
    return { values: sorted, includes: (candidate) => accepted.has(candidate) };
}
/** Parse and normalize a strict five-field cron expression. */
export function parseCronExpression(value) {
    if (typeof value !== 'string')
        throw new Error('Cron 必须是 5 段表达式（分 时 日 月 周）');
    const fields = value.trim().split(/\s+/);
    if (fields.length !== 5)
        throw new Error('Cron 必须正好包含 5 段（分 时 日 月 周）');
    const parsed = fields.map((field, index) => {
        const spec = CRON_FIELD_SPECS[index];
        return parseCronField(field, spec.label, spec.min, spec.max);
    });
    return {
        normalized: fields.join(' '),
        minute: parsed[0],
        hour: parsed[1],
        day: parsed[2],
        month: parsed[3],
        dayOfWeek: parsed[4],
    };
}
export function normalizeCronExpression(value) {
    return parseCronExpression(value).normalized;
}
/**
 * Normalize a configured IANA timezone. Empty values intentionally remain
 * undefined so legacy schedules continue using the host's local timezone.
 */
export function normalizeScheduleTimezone(value) {
    if (value === undefined || value === null)
        return undefined;
    if (typeof value !== 'string')
        throw new Error('时区必须是 IANA 时区名称');
    const candidate = value.trim();
    if (!candidate)
        return undefined;
    if (candidate.length > 128 || /[\u0000-\u001f\u007f]/.test(candidate))
        throw new Error('时区名称无效');
    if (candidate !== 'UTC' && candidate !== 'GMT' && !/^[A-Za-z][A-Za-z0-9._+-]*(?:\/[A-Za-z0-9._+-]+)+$/.test(candidate)) {
        throw new Error('时区必须是 IANA 名称，例如 Asia/Shanghai');
    }
    try {
        const normalized = new Intl.DateTimeFormat('en-US', { timeZone: candidate }).resolvedOptions().timeZone;
        if (!normalized)
            throw new Error('empty timezone');
        return normalized;
    }
    catch {
        throw new Error(`未知时区：“${candidate}”`);
    }
}
export function validateScheduleConfiguration(cron, timezone) {
    return { cron: normalizeCronExpression(cron), timezone: normalizeScheduleTimezone(timezone) };
}
export function hostScheduleTimezone() {
    try {
        return new Intl.DateTimeFormat().resolvedOptions().timeZone || '本地时区';
    }
    catch {
        return '本地时区';
    }
}
export function formatScheduleTimezone(timezone) {
    return timezone || `系统时区（${hostScheduleTimezone()}）`;
}
function zonedFormatter(timezone) {
    let formatter = zonedFormatterCache.get(timezone);
    if (!formatter) {
        formatter = new Intl.DateTimeFormat('en-US-u-ca-gregory-nu-latn', {
            timeZone: timezone,
            weekday: 'short',
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            hourCycle: 'h23',
        });
        zonedFormatterCache.set(timezone, formatter);
    }
    return formatter;
}
function numericPart(parts, type) {
    const value = parts.find((part) => part.type === type)?.value;
    const parsed = Number(value);
    if (!Number.isInteger(parsed))
        throw new Error(`无法读取日期的 ${type} 部分`);
    return parsed;
}
function localDateParts(date) {
    return {
        year: date.getFullYear(),
        month: date.getMonth() + 1,
        day: date.getDate(),
        hour: date.getHours(),
        minute: date.getMinutes(),
        dayOfWeek: date.getDay(),
    };
}
/** Read a Date as wall-clock components in the configured or host-local zone. */
export function scheduleDateParts(date, timezone) {
    if (!timezone)
        return localDateParts(date);
    const parts = zonedFormatter(timezone).formatToParts(date);
    const weekdayText = parts.find((part) => part.type === 'weekday')?.value.slice(0, 3).toLowerCase();
    const dayOfWeek = weekdayText === 'sun' ? 0
        : weekdayText === 'mon' ? 1
            : weekdayText === 'tue' ? 2
                : weekdayText === 'wed' ? 3
                    : weekdayText === 'thu' ? 4
                        : weekdayText === 'fri' ? 5
                            : weekdayText === 'sat' ? 6
                                : undefined;
    if (dayOfWeek === undefined)
        throw new Error('无法读取时区的星期信息');
    return {
        year: numericPart(parts, 'year'),
        month: numericPart(parts, 'month'),
        day: numericPart(parts, 'day'),
        hour: numericPart(parts, 'hour'),
        minute: numericPart(parts, 'minute'),
        dayOfWeek,
    };
}
function cronMatchesParsed(cron, parts) {
    // Preserve the legacy scheduler's all-fields-match behavior for day-of-month
    // and day-of-week rather than silently changing existing schedules to OR.
    return cron.minute.includes(parts.minute)
        && cron.hour.includes(parts.hour)
        && cron.day.includes(parts.day)
        && cron.month.includes(parts.month)
        && cron.dayOfWeek.includes(parts.dayOfWeek);
}
/** True when a cron expression matches this instant in its configured zone. */
export function cronMatchesSchedule(cron, date, timezone) {
    try {
        return cronMatchesParsed(parseCronExpression(cron), scheduleDateParts(date, timezone));
    }
    catch {
        return false;
    }
}
function pad(value) {
    return String(value).padStart(2, '0');
}
/** A stable wall-clock minute key used to suppress duplicate DST fall-back runs. */
export function scheduleWallClockKey(date, timezone) {
    const parts = scheduleDateParts(date, timezone);
    const zone = timezone || `local:${hostScheduleTimezone()}`;
    return `${zone}|${parts.year}-${pad(parts.month)}-${pad(parts.day)}T${pad(parts.hour)}:${pad(parts.minute)}`;
}
/** Existing persisted schedules use this UTC minute key; retain it for compatibility. */
export function scheduleInstantMinuteKey(date) {
    return date.toISOString().slice(0, 16);
}
function parseInstantMinuteKey(value) {
    const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value);
    if (!match)
        return undefined;
    const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]), Number(match[4])));
    return Number.isNaN(date.getTime()) ? undefined : date;
}
/** Format an instant as an unambiguous, compact wall-clock value in a schedule's zone. */
export function formatScheduleTime(value, timezone) {
    if (!value)
        return undefined;
    const date = value instanceof Date
        ? value
        : parseInstantMinuteKey(value) ?? new Date(value);
    if (Number.isNaN(date.getTime()))
        return undefined;
    const parts = scheduleDateParts(date, timezone);
    return `${parts.year}-${pad(parts.month)}-${pad(parts.day)} ${pad(parts.hour)}:${pad(parts.minute)}`;
}
function localWallClockInstant(parts) {
    const instant = new Date(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, 0, 0);
    return localDateParts(instant).year === parts.year
        && localDateParts(instant).month === parts.month
        && localDateParts(instant).day === parts.day
        && localDateParts(instant).hour === parts.hour
        && localDateParts(instant).minute === parts.minute
        ? [instant]
        : [];
}
function timezoneOffsetAt(date, timezone) {
    const parts = scheduleDateParts(date, timezone);
    const rounded = Math.floor(date.getTime() / 60_000) * 60_000;
    return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute) - rounded;
}
function zonedWallClockInstants(parts, timezone) {
    const nominal = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute);
    const offsets = new Set();
    for (const hours of [-48, -24, -12, 0, 12, 24, 48]) {
        offsets.add(timezoneOffsetAt(new Date(nominal + hours * 60 * 60 * 1000), timezone));
    }
    const candidates = new Map();
    for (const offset of offsets) {
        const instant = new Date(nominal - offset);
        const actual = scheduleDateParts(instant, timezone);
        if (actual.year === parts.year
            && actual.month === parts.month
            && actual.day === parts.day
            && actual.hour === parts.hour
            && actual.minute === parts.minute)
            candidates.set(instant.getTime(), instant);
    }
    return [...candidates.values()].sort((left, right) => left.getTime() - right.getTime());
}
function wallClockInstants(parts, timezone) {
    return timezone ? zonedWallClockInstants(parts, timezone) : localWallClockInstant(parts);
}
/**
 * Find the next scheduled instant after `from`. Spring-forward gaps have no
 * corresponding instant and are skipped. When `skipWallClockKey` is provided,
 * both instances of an autumn fall-back wall-clock minute are skipped.
 */
export function nextScheduleFire(cronValue, from, timezone, skipWallClockKey) {
    let cron;
    let normalizedTimezone;
    try {
        cron = parseCronExpression(cronValue);
        normalizedTimezone = normalizeScheduleTimezone(timezone);
    }
    catch {
        return null;
    }
    if (Number.isNaN(from.getTime()))
        return null;
    const start = scheduleDateParts(from, normalizedTimezone);
    const firstDay = new Date(Date.UTC(start.year, start.month - 1, start.day));
    const hours = cron.hour.values;
    const minutes = cron.minute.values;
    const maxDays = 366 * 8;
    for (let offset = 0; offset < maxDays; offset++) {
        const cursor = new Date(firstDay.getTime());
        cursor.setUTCDate(cursor.getUTCDate() + offset);
        const year = cursor.getUTCFullYear();
        const month = cursor.getUTCMonth() + 1;
        const day = cursor.getUTCDate();
        const dayOfWeek = cursor.getUTCDay();
        if (!cron.month.includes(month) || !cron.day.includes(day) || !cron.dayOfWeek.includes(dayOfWeek))
            continue;
        for (const hour of hours) {
            for (const minute of minutes) {
                const wallClock = { year, month, day, hour, minute, dayOfWeek };
                for (const candidate of wallClockInstants(wallClock, normalizedTimezone)) {
                    if (candidate.getTime() <= from.getTime())
                        continue;
                    if (skipWallClockKey && scheduleWallClockKey(candidate, normalizedTimezone) === skipWallClockKey)
                        continue;
                    return candidate;
                }
            }
        }
    }
    return null;
}
