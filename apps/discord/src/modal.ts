/**
 * Modal field extraction.
 *
 * dfx's `Ix.modalValue` only descends `components` arrays and misses the
 * `component` (singular) child of Label components, so every modal field would
 * read as missing. This walker understands both shapes and returns a typed
 * map: text inputs record `custom_id → value`, selects record
 * `custom_id → values`.
 */
import type * as Discord from "dfx/types";

/** Component type numbers from the Discord component reference. */
const ACTION_ROW = 1;
const STRING_SELECT = 3;
const TEXT_INPUT = 4;
const LABEL = 18;

/** One extracted modal field: a text input value or a select's chosen values. */
export type ModalField = string | readonly string[];

/**
 * The top-level modal submission component union (action row | label | text
 * display). dfx re-exports `APIModalSubmission` but not its component union,
 * so it is read off the payload type itself.
 */
type SubmissionComponent = Discord.APIModalSubmission["components"][number];
/** The only submission component wrapping a child: the Label. */
type LabeledComponent = Extract<SubmissionComponent, { component: unknown }>;
/** The only submission component holding a list of children: the Action Row. */
type RowComponent = Extract<SubmissionComponent, { components: readonly unknown[] }>;
/** Leaf modal components: what a Label or an Action Row directly contains. */
type LeafComponent = LabeledComponent["component"] | RowComponent["components"][number];

function isStringArray(value: ModalField): value is readonly string[] {
    return globalThis.Array.isArray(value);
}

function visitLeaf(component: LeafComponent, fields: Map<string, ModalField>): void {
    if (component.type === TEXT_INPUT) {
        fields.set(component.custom_id, component.value);
        return;
    }
    if (component.type === STRING_SELECT) {
        fields.set(component.custom_id, component.values);
    }
    // Radio groups, checkboxes and other select kinds are not used by any of
    // this bot's modals; their fields are intentionally skipped.
}

function visitContainer(component: SubmissionComponent, fields: Map<string, ModalField>): void {
    if (component.type === ACTION_ROW) {
        const row: RowComponent = component;
        for (const child of row.components) visitLeaf(child, fields);
        return;
    }
    if (component.type === LABEL) {
        const label: LabeledComponent = component;
        visitLeaf(label.component, fields);
        return;
    }
    // The remaining member is the text display, which carries no field.
}

/**
 * Extract every field of a modal submission. Later components with the same
 * `custom_id` win; Discord guarantees unique ids inside one modal.
 */
export function modalFields(data: Discord.APIModalSubmission): Map<string, ModalField> {
    const fields = new Map<string, ModalField>();
    for (const component of data.components) visitContainer(component, fields);
    return fields;
}

/**
 * Read one field as its first chosen/text value. A select with no selection
 * (not possible here — every select is `required: true`) reads as `null`.
 */
export function textField(fields: Map<string, ModalField>, name: string): string | null {
    const value = fields.get(name);
    if (value === undefined) return null;
    if (isStringArray(value)) return value[0] ?? null;
    return value;
}

/** Read one field as a select's chosen values; a text input reads as `[value]`. */
export function selectValues(fields: Map<string, ModalField>, name: string): readonly string[] {
    const value = fields.get(name);
    if (value === undefined) return [];
    if (isStringArray(value)) return value;
    return [value];
}
