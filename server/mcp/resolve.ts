// Field-value resolution for MCP output.
//
// Board columns store raw values in item_field_values keyed by column id:
//   status/dropdown → option id (string)   → resolve to the option label
//   multi_select    → string[] of option ids → resolve each to its label
//   person          → number[] of user ids → resolve to names
//   date            → ISO string
//   everything else → passthrough (string/number)
//
// This mirrors the resolution the board UI does client-side, but produces
// human-readable, LLM-friendly values so a model never sees an opaque option id.

import type { schema } from '~~/server/utils/neon'

type Column = Pick<
  typeof schema.boardColumns.$inferSelect,
  'id' | 'key' | 'label' | 'kind' | 'config' | 'isPrimary'
>

type Option = { id?: string, label?: string, color?: string }

function optionLabel(config: unknown, optionId: unknown): string {
  const opts = (config as { options?: Option[] } | null)?.options
  if (Array.isArray(opts) && typeof optionId === 'string') {
    const match = opts.find(o => o.id === optionId)
    if (match?.label) return match.label
  }
  return typeof optionId === 'string' ? optionId : String(optionId ?? '')
}

/**
 * Resolve one raw field value into a display value.
 * `userNames` maps userId → display name (name || email).
 */
export function resolveFieldValue(
  col: Column,
  raw: unknown,
  userNames: Map<number, string>,
): unknown {
  if (raw === null || raw === undefined) return null
  switch (col.kind) {
    case 'status':
    case 'dropdown':
      return optionLabel(col.config, raw)
    case 'multi_select':
      if (Array.isArray(raw)) return raw.map(id => optionLabel(col.config, id))
      return optionLabel(col.config, raw)
    case 'person':
      if (Array.isArray(raw)) {
        return raw
          .map(uid => (typeof uid === 'number' ? (userNames.get(uid) ?? `user:${uid}`) : String(uid)))
      }
      return raw
    default:
      return raw
  }
}

/**
 * Build a {columnLabel: resolvedValue} object for one item.
 * Skips the primary column (that's surfaced as the item name) and null values.
 */
export function resolveItemFields(
  columns: Column[],
  valuesByColumnId: Record<number, unknown>,
  userNames: Map<number, string>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const col of columns) {
    if (col.isPrimary === 'true') continue
    const raw = valuesByColumnId[col.id]
    if (raw === null || raw === undefined) continue
    out[col.label] = resolveFieldValue(col, raw, userNames)
  }
  return out
}

/** Collect user ids referenced by person-kind columns across many items. */
export function collectPersonUserIds(
  columns: Column[],
  valuesByItem: Record<number, Record<number, unknown>>,
): Set<number> {
  const personColIds = columns.filter(c => c.kind === 'person').map(c => c.id)
  const ids = new Set<number>()
  for (const itemVals of Object.values(valuesByItem)) {
    for (const colId of personColIds) {
      const v = itemVals?.[colId]
      if (Array.isArray(v)) for (const uid of v) if (typeof uid === 'number') ids.add(uid)
    }
  }
  return ids
}
