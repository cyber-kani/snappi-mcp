// MCP tool registry.
//
// A tool is a self-contained {name, description, inputSchema, requiredScope,
// handler} record. Read tools live in tools-read.ts; a later write-tools agent
// adds its own module and calls registerTools() to append — no edits to this
// file's tool list needed beyond the import + spread at the bottom.
//
// inputSchema is a hand-written JSON Schema object (draft-07 flavour). It is
// sent verbatim to the LLM in tools/list, so the property descriptions matter:
// they are how ChatGPT/Claude decide how to fill arguments. Argument coercion
// and validation happens in the endpoint via the helpers in ./validate.

import type { ApiTokenPrincipal } from '~~/server/utils/api-token'

export type ToolDef = {
  name: string
  description: string
  inputSchema: object // JSON Schema
  requiredScope: 'read' | 'write'
  handler: (args: any, principal: ApiTokenPrincipal) => Promise<unknown>
}

export const tools: ToolDef[] = []

export function registerTools(defs: ToolDef[]): void {
  for (const def of defs) {
    // Guard against accidental duplicate names across modules — the first
    // registration wins and a duplicate is a bug worth surfacing loudly.
    if (tools.some(t => t.name === def.name)) {
      console.warn(`[mcp] duplicate tool registration ignored: ${def.name}`)
      continue
    }
    tools.push(def)
  }
}

export function findTool(name: string): ToolDef | undefined {
  return tools.find(t => t.name === name)
}

// ---- Register the built-in tool sets ----
// Read tools. The write-tools agent should add its module the same way:
//   import { writeTools } from './tools-write'
//   registerTools(writeTools)
import { readTools } from '~~/server/mcp/tools-read'
import { writeTools } from '~~/server/mcp/tools-write'

registerTools(readTools)
registerTools(writeTools)
