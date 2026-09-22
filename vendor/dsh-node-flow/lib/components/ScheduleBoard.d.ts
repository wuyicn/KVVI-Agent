/**
 * Scheduled-task board — lists every saved schedule (cron workflow). Lets the
 * user view the latest run result for the current workflow, run once
 * immediately, or cancel a schedule.
 *
 * @module components/ScheduleBoard
 */
export declare function ScheduleBoard({ workflowId, onClose, onViewRun, }: {
    workflowId?: string;
    onClose: () => void;
    onViewRun?: () => void;
}): import("react").JSX.Element;
