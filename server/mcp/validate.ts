// Tiny hand-rolled arg coercion/validation for MCP tool calls.
//
// We deliberately do NOT pull in a JSON-Schema validator or zod-to-schema
// round-trip: the tool set is small and the schemas are simple. These helpers
// coerce the loosely-typed JSON that LLMs send (numbers as strings, etc.) into
// the shapes handlers expect, and throw a McpArgError with a readable message
// when something is wrong. The endpoint turns that into an isError result.

export class McpArgError extends Error {}

export function optString(args: Record<string, unknown>, key: string): string | undefined {
  const v = args?.[key]
  if (v === undefined || v === null || v === '') return undefined
  if (typeof v !== 'string') throw new McpArgError(`"${key}" must be a string`)
  return v
}

export function optBool(args: Record<string, unknown>, key: string): boolean | undefined {
  const v = args?.[key]
  if (v === undefined || v === null) return undefined
  if (typeof v === 'boolean') return v
  if (v === 'true') return true
  if (v === 'false') return false
  throw new McpArgError(`"${key}" must be a boolean`)
}

/** Coerce an integer id. LLMs frequently send ids as strings. */
export function reqInt(args: Record<string, unknown>, key: string): number {
  const v = args?.[key]
  if (v === undefined || v === null || v === '') throw new McpArgError(`"${key}" is required`)
  const n = typeof v === 'number' ? v : Number(v)
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) {
    throw new McpArgError(`"${key}" must be a positive integer`)
  }
  return n
}

export function optInt(args: Record<string, unknown>, key: string): number | undefined {
  const v = args?.[key]
  if (v === undefined || v === null || v === '') return undefined
  const n = typeof v === 'number' ? v : Number(v)
  if (!Number.isFinite(n) || !Number.isInteger(n)) throw new McpArgError(`"${key}" must be an integer`)
  return n
}

/** Clamp an optional limit into [1, max] with a default. */
export function limitArg(args: Record<string, unknown>, def: number, max: number): number {
  const n = optInt(args, 'limit')
  if (n === undefined) return def
  if (n < 1) return 1
  if (n > max) return max
  return n
}

export function enumArg<T extends string>(
  args: Record<string, unknown>,
  key: string,
  allowed: readonly T[],
  def?: T,
): T {
  const v = args?.[key]
  if (v === undefined || v === null || v === '') {
    if (def !== undefined) return def
    throw new McpArgError(`"${key}" is required (one of: ${allowed.join(', ')})`)
  }
  if (typeof v !== 'string' || !allowed.includes(v as T)) {
    throw new McpArgError(`"${key}" must be one of: ${allowed.join(', ')}`)
  }
  return v as T
}
