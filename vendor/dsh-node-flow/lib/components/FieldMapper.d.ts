export type FieldMappingMode = 'template' | 'expression';
export type FieldMappingSource = {
    id: string;
    label: string;
    detail: string;
    value: unknown;
    namespace?: 'result' | 'vars';
};
export declare function FieldMapper({ targetLabel, mode, sources, onInsert, onClose, }: {
    targetLabel: string;
    mode: FieldMappingMode;
    sources: FieldMappingSource[];
    onInsert: (text: string) => void;
    onClose: () => void;
}): import("react").JSX.Element;
