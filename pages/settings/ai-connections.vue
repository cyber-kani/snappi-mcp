<script setup lang="ts">
definePageMeta({ layout: 'app' })
useHead({ title: 'AI Connections' })

type ApiToken = {
  id: number
  name: string
  tokenPrefix: string
  scopes: string[]
  clientInfo: Record<string, unknown> | null
  lastUsedAt: string | null
  expiresAt: string | null
  revokedAt: string | null
  createdAt: string
}

// ─── Token list ────────────────────────────────────────────────────────────
const { data: tokensRes, refresh: refreshTokens } = await useFetch<{ tokens: ApiToken[] }>(
  '/api/me/api-tokens',
  { default: () => ({ tokens: [] }) },
)
const tokens = computed(() => tokensRes.value?.tokens ?? [])

// ─── Toasts + confirm ──────────────────────────────────────────────────────
const { show: showToast } = useToasts()
const { show: showConfirm } = useConfirm()

// ─── MCP endpoint copy ─────────────────────────────────────────────────────
const MCP_URL = 'https://app.snappi.now/mcp'
const mcpCopied = ref(false)
async function copyMcpUrl() {
  await navigator.clipboard.writeText(MCP_URL)
  mcpCopied.value = true
  setTimeout(() => { mcpCopied.value = false }, 2000)
}

// ─── Accordion (how-to guides) ─────────────────────────────────────────────
const openGuide = ref<'claude' | 'chatgpt' | null>(null)
function toggleGuide(g: 'claude' | 'chatgpt') {
  openGuide.value = openGuide.value === g ? null : g
}

// ─── Revoke token ─────────────────────────────────────────────────────────
const revoking = ref<number | null>(null)
async function revokeToken(token: ApiToken) {
  const ok = await showConfirm({
    title: `Revoke "${token.name}"?`,
    message: 'Any AI assistant using it will immediately lose access to your Snappi boards.',
    confirmText: 'Revoke token',
    kind: 'danger',
  })
  if (!ok) return

  revoking.value = token.id
  try {
    await $fetch(`/api/me/api-tokens/${token.id}`, { method: 'DELETE' })
    showToast({ kind: 'success', title: 'Token revoked', message: `"${token.name}" can no longer be used.` })
    await refreshTokens()
  } catch (e) {
    showToast({ kind: 'error', title: 'Could not revoke token', message: (e as { statusMessage?: string })?.statusMessage ?? 'An error occurred.' })
  } finally {
    revoking.value = null
  }
}

// ─── New token modal ──────────────────────────────────────────────────────
const showNewTokenModal = ref(false)
const newTokenName = ref('')
const newTokenAccess = ref<'read' | 'readwrite'>('read')
const creating = ref(false)
const createError = ref<string | null>(null)

// Result state (raw token shown once)
const createdToken = ref<string | null>(null)
const createdTokenCopied = ref(false)

function openNewTokenModal() {
  newTokenName.value = ''
  newTokenAccess.value = 'read'
  createError.value = null
  createdToken.value = null
  createdTokenCopied.value = false
  showNewTokenModal.value = true
}

function closeNewTokenModal() {
  showNewTokenModal.value = false
  createdToken.value = null
  createdTokenCopied.value = false
}

async function createToken() {
  const name = newTokenName.value.trim()
  if (!name) { createError.value = 'Name is required.'; return }
  if (name.length > 60) { createError.value = 'Name must be 60 characters or fewer.'; return }

  creating.value = true
  createError.value = null
  try {
    const scopes = newTokenAccess.value === 'readwrite' ? ['read', 'write'] : ['read']
    const res = await $fetch<{ token: string; id: number }>('/api/me/api-tokens', {
      method: 'POST',
      body: { name, scopes },
    })
    createdToken.value = res.token
    await refreshTokens()
  } catch (e) {
    createError.value = (e as { statusMessage?: string })?.statusMessage ?? 'Could not create the token.'
  } finally {
    creating.value = false
  }
}

async function copyCreatedToken() {
  if (!createdToken.value) return
  await navigator.clipboard.writeText(createdToken.value)
  createdTokenCopied.value = true
  setTimeout(() => { createdTokenCopied.value = false }, 2000)
}

// ─── Formatting helpers ───────────────────────────────────────────────────
function relativeTime(iso: string | null): string {
  if (!iso) return 'Never'
  const ms = Date.now() - new Date(iso).getTime()
  const s = Math.floor(ms / 1000)
  if (s < 60) return 'Just now'
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.floor(h / 24)
  if (d < 30) return `${d}d ago`
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
}
</script>

<template>
  <SettingsShell title="AI Connections" subtitle="Connect Claude, ChatGPT and other AI assistants to your Snappi boards via MCP.">

    <!-- ── MCP endpoint card ────────────────────────────────────────────── -->
    <section class="settings-card">
      <div class="settings-row">
        <div class="settings-row-meta">
          <h2>MCP endpoint</h2>
          <p>
            Paste this URL into any MCP-compatible AI assistant to give it access to your boards.
            The server is <a class="aic-gh-link" href="https://github.com/cyber-kani/snappi-mcp" target="_blank" rel="noopener">open source on GitHub</a>.
          </p>
        </div>
        <div class="settings-row-control">
          <div class="aic-endpoint-row">
            <code class="aic-url">{{ MCP_URL }}</code>
            <button type="button" class="sec-btn aic-copy-btn" @click="copyMcpUrl">
              <svg v-if="!mcpCopied" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
              </svg>
              <svg v-else width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                <polyline points="20 6 9 17 4 12"/>
              </svg>
              {{ mcpCopied ? 'Copied!' : 'Copy' }}
            </button>
          </div>
        </div>
      </div>

      <!-- How-to accordion -->
      <div class="aic-accordion">
        <!-- Claude -->
        <div class="aic-accordion-item" :class="{ open: openGuide === 'claude' }">
          <button type="button" class="aic-accordion-trigger" @click="toggleGuide('claude')">
            <span class="aic-accordion-label">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
                <circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3m.08 4h.01"/>
              </svg>
              Connect Claude
            </span>
            <svg class="aic-chevron" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <polyline points="6 9 12 15 18 9"/>
            </svg>
          </button>
          <div v-if="openGuide === 'claude'" class="aic-accordion-body">
            <p class="aic-guide-subtitle">claude.ai</p>
            <ol class="aic-steps">
              <li>Go to <strong>claude.ai → Settings → Connectors</strong></li>
              <li>Click <strong>Add custom connector</strong></li>
              <li>Paste the MCP endpoint URL above</li>
              <li>Sign in and authorise Snappi when prompted</li>
            </ol>
            <p class="aic-guide-subtitle">Claude Code (CLI)</p>
            <div class="aic-code-block">
              <code>claude mcp add --transport http snappi https://app.snappi.now/mcp --header "Authorization: Bearer &lt;token&gt;"</code>
            </div>
            <p class="aic-code-hint">Replace <code>&lt;token&gt;</code> with a personal access token created below.</p>
          </div>
        </div>

        <!-- ChatGPT -->
        <div class="aic-accordion-item" :class="{ open: openGuide === 'chatgpt' }">
          <button type="button" class="aic-accordion-trigger" @click="toggleGuide('chatgpt')">
            <span class="aic-accordion-label">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
                <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
              </svg>
              Connect ChatGPT
            </span>
            <svg class="aic-chevron" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <polyline points="6 9 12 15 18 9"/>
            </svg>
          </button>
          <div v-if="openGuide === 'chatgpt'" class="aic-accordion-body">
            <ol class="aic-steps">
              <li>Go to <strong>ChatGPT → Settings → Connectors</strong></li>
              <li>Enable <strong>Advanced / Developer mode</strong></li>
              <li>Click <strong>Add MCP server</strong></li>
              <li>Paste the MCP endpoint URL above</li>
              <li>Follow the OAuth prompt to authorise Snappi</li>
            </ol>
          </div>
        </div>
      </div>
    </section>

    <!-- ── Personal access tokens ─────────────────────────────────────────── -->
    <div class="aic-tokens-header">
      <div>
        <p class="aic-section-title">Personal access tokens</p>
        <p class="aic-section-sub">Use a token as the Bearer value in the Authorization header when prompted by an AI assistant.</p>
      </div>
      <button type="button" class="aic-new-btn" @click="openNewTokenModal">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
          <line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>
        </svg>
        New token
      </button>
    </div>

    <section class="settings-card aic-tokens-card">
      <!-- Empty state -->
      <div v-if="tokens.length === 0" class="aic-empty">
        <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round">
          <rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>
        </svg>
        <p class="aic-empty-title">No tokens yet</p>
        <p class="aic-empty-sub">Create a token to connect an AI assistant. The raw token is shown once at creation.</p>
        <button type="button" class="aic-new-btn" @click="openNewTokenModal">Create your first token</button>
      </div>

      <!-- Token list -->
      <template v-else>
        <div v-for="token in tokens" :key="token.id" class="aic-token-row">
          <div class="aic-token-main">
            <span class="aic-token-name">{{ token.name }}</span>
            <code class="aic-token-prefix">{{ token.tokenPrefix }}…</code>
          </div>
          <div class="aic-token-meta">
            <span
              v-for="scope in (token.scopes as string[])"
              :key="scope"
              class="aic-scope-badge"
              :class="scope === 'write' ? 'aic-scope-badge--write' : ''"
            >{{ scope }}</span>
          </div>
          <div class="aic-token-dates">
            <span class="aic-token-date-label">Last used</span>
            <span class="aic-token-date-val">{{ relativeTime(token.lastUsedAt) }}</span>
          </div>
          <div class="aic-token-dates">
            <span class="aic-token-date-label">Created</span>
            <span class="aic-token-date-val">{{ formatDate(token.createdAt) }}</span>
          </div>
          <button
            type="button"
            class="aic-revoke-btn"
            :disabled="revoking === token.id"
            @click="revokeToken(token)"
          >
            {{ revoking === token.id ? 'Revoking…' : 'Revoke' }}
          </button>
        </div>
      </template>
    </section>

    <!-- ── New token modal ───────────────────────────────────────────────── -->
    <Teleport to="body">
      <div v-if="showNewTokenModal" class="aic-modal-overlay" @click.self="!creating && closeNewTokenModal()">
        <div class="aic-modal" role="dialog" aria-modal="true" aria-labelledby="modal-title">
          <div class="aic-modal-head">
            <h2 id="modal-title" class="aic-modal-title">
              {{ createdToken ? 'Save your token' : 'New personal access token' }}
            </h2>
            <button v-if="!creating" type="button" class="aic-modal-close" aria-label="Close" @click="closeNewTokenModal">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
              </svg>
            </button>
          </div>

          <!-- Creation form -->
          <template v-if="!createdToken">
            <div class="aic-modal-body">
              <label class="aic-field-label" for="token-name">Token name</label>
              <input
                id="token-name"
                v-model="newTokenName"
                class="input"
                placeholder="e.g. Claude Desktop"
                maxlength="60"
                :disabled="creating"
                @keyup.enter="createToken"
              >

              <fieldset class="aic-access-fieldset">
                <legend class="aic-field-label">Access level</legend>
                <label class="aic-radio">
                  <input v-model="newTokenAccess" type="radio" value="read" :disabled="creating">
                  <span class="aic-radio-label">
                    <strong>Read only</strong>
                    <span>Can view boards, items, and comments — cannot create or modify anything.</span>
                  </span>
                </label>
                <label class="aic-radio">
                  <input v-model="newTokenAccess" type="radio" value="readwrite" :disabled="creating">
                  <span class="aic-radio-label">
                    <strong>Read &amp; write</strong>
                    <span>Can view and update boards, items, and comments on your behalf.</span>
                  </span>
                </label>
              </fieldset>

              <p v-if="createError" class="aic-modal-error">{{ createError }}</p>
            </div>

            <div class="aic-modal-foot">
              <button type="button" class="sec-cancel" :disabled="creating" @click="closeNewTokenModal">Cancel</button>
              <button
                type="button"
                class="aic-create-btn"
                :disabled="creating || !newTokenName.trim()"
                @click="createToken"
              >
                {{ creating ? 'Creating…' : 'Create token' }}
              </button>
            </div>
          </template>

          <!-- Result: raw token shown once -->
          <template v-else>
            <div class="aic-modal-body">
              <div class="aic-amber-warn">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>
                </svg>
                Copy it now — you won't see it again.
              </div>
              <div class="aic-raw-token-wrap">
                <code class="aic-raw-token">{{ createdToken }}</code>
                <button type="button" class="aic-token-copy-btn" @click="copyCreatedToken">
                  <svg v-if="!createdTokenCopied" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
                  </svg>
                  <svg v-else width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                    <polyline points="20 6 9 17 4 12"/>
                  </svg>
                  {{ createdTokenCopied ? 'Copied!' : 'Copy' }}
                </button>
              </div>
            </div>
            <div class="aic-modal-foot">
              <button type="button" class="aic-create-btn" @click="closeNewTokenModal">Done</button>
            </div>
          </template>
        </div>
      </div>
    </Teleport>
  </SettingsShell>
</template>

<style scoped>
/* ── MCP endpoint ─────────────────────────────────────────────────────── */
.aic-gh-link {
  color: var(--brand, #0ea5e9);
  text-decoration: none;
  font-weight: 500;
}
.aic-gh-link:hover {
  text-decoration: underline;
}
.aic-endpoint-row {
  display: flex;
  align-items: center;
  gap: 10px;
}
.aic-url {
  flex: 1;
  display: block;
  padding: 9px 12px;
  border: 1px solid var(--border-medium);
  border-radius: 8px;
  background: var(--surface-raised, rgba(var(--on-surface-rgb), 0.03));
  font-family: var(--font-mono);
  font-size: 13px;
  color: var(--text);
  white-space: nowrap;
  overflow: auto;
}
.aic-copy-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
}

/* ── Accordion ────────────────────────────────────────────────────────── */
.aic-accordion {
  border-top: 1px solid var(--border);
}
.aic-accordion-item {
  border-bottom: 1px solid var(--border);
}
.aic-accordion-trigger {
  width: 100%;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 14px 20px;
  text-align: left;
  background: transparent;
  font-size: 13.5px;
  font-weight: 600;
  color: var(--text);
}
.aic-accordion-trigger:hover { background: rgba(var(--on-surface-rgb), 0.03); }
.aic-accordion-label {
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--text);
}
.aic-accordion-label svg { color: var(--text-muted); flex-shrink: 0; }
.aic-chevron {
  color: var(--text-muted);
  transition: transform 0.18s ease;
  flex-shrink: 0;
}
.aic-accordion-item.open .aic-chevron { transform: rotate(180deg); }

.aic-accordion-body {
  padding: 0 20px 18px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.aic-guide-subtitle {
  margin: 0;
  font-size: 11.5px;
  font-weight: 700;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--text-subtle);
}
.aic-steps {
  margin: 0;
  padding-left: 20px;
  display: flex;
  flex-direction: column;
  gap: 5px;
  font-size: 13px;
  color: var(--text-muted);
  line-height: 1.55;
}
.aic-steps strong { color: var(--text); }
.aic-code-block {
  display: block;
  padding: 10px 14px;
  border-radius: 8px;
  background: rgba(var(--on-surface-rgb), 0.05);
  border: 1px solid var(--border);
  font-family: var(--font-mono);
  font-size: 12.5px;
  color: var(--text);
  overflow-x: auto;
  white-space: nowrap;
}
.aic-code-hint {
  margin: 0;
  font-size: 12px;
  color: var(--text-subtle);
}
.aic-code-hint code {
  font-family: var(--font-mono);
  font-size: 11.5px;
  background: rgba(var(--on-surface-rgb), 0.06);
  padding: 1px 4px;
  border-radius: 4px;
}

/* ── Tokens section header ────────────────────────────────────────────── */
.aic-tokens-header {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: 16px;
  margin: 28px 0 10px;
}
.aic-section-title {
  margin: 0 0 3px;
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--text-subtle);
}
.aic-section-sub {
  margin: 0;
  font-size: 12.5px;
  color: var(--text-muted);
}
.aic-new-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 36px;
  padding: 0 14px;
  border-radius: 9px;
  background: var(--brand);
  color: #fff;
  font-size: 13px;
  font-weight: 600;
  flex-shrink: 0;
}
.aic-new-btn:hover { opacity: 0.92; }

/* ── Token list card ──────────────────────────────────────────────────── */
.aic-tokens-card { overflow: hidden; }

.aic-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  padding: 40px 24px;
  text-align: center;
  color: var(--text-muted);
}
.aic-empty svg { color: var(--border-strong); }
.aic-empty-title { margin: 0; font-size: 14px; font-weight: 700; color: var(--text); }
.aic-empty-sub { margin: 0 0 8px; font-size: 13px; color: var(--text-muted); max-width: 340px; line-height: 1.5; }

.aic-token-row {
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 14px 20px;
  border-bottom: 1px solid var(--border);
}
.aic-token-row:last-child { border-bottom: 0; }
.aic-token-main {
  display: flex;
  flex-direction: column;
  gap: 3px;
  min-width: 0;
  flex: 1 1 180px;
}
.aic-token-name {
  font-size: 13.5px;
  font-weight: 600;
  color: var(--text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.aic-token-prefix {
  font-family: var(--font-mono);
  font-size: 11.5px;
  color: var(--text-subtle);
}
.aic-token-meta {
  display: flex;
  gap: 5px;
  flex-shrink: 0;
}
.aic-scope-badge {
  display: inline-flex;
  align-items: center;
  height: 20px;
  padding: 0 7px;
  border-radius: 5px;
  background: rgba(var(--on-surface-rgb), 0.07);
  font-size: 10.5px;
  font-weight: 700;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--text-muted);
}
.aic-scope-badge--write {
  background: rgba(14, 165, 233, 0.12);
  color: #0284c7;
}
:root[data-theme="dark"] .aic-scope-badge--write { color: #38bdf8; }

.aic-token-dates {
  display: flex;
  flex-direction: column;
  gap: 2px;
  flex-shrink: 0;
  min-width: 80px;
}
.aic-token-date-label {
  font-size: 10.5px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--text-subtle);
}
.aic-token-date-val { font-size: 12.5px; color: var(--text-muted); }

.aic-revoke-btn {
  flex-shrink: 0;
  height: 32px;
  padding: 0 12px;
  border: 1px solid rgba(226, 68, 92, 0.4);
  border-radius: 7px;
  color: #E2445C;
  background: transparent;
  font-size: 12.5px;
  font-weight: 600;
}
.aic-revoke-btn:hover:not(:disabled) { background: rgba(226, 68, 92, 0.08); }
.aic-revoke-btn:disabled { opacity: 0.5; cursor: not-allowed; }

/* ── Modal ────────────────────────────────────────────────────────────── */
.aic-modal-overlay {
  position: fixed;
  inset: 0;
  z-index: 9999;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.45);
  backdrop-filter: blur(3px);
}
.aic-modal {
  width: 100%;
  max-width: 480px;
  margin: 16px;
  background: var(--surface);
  border: 1px solid var(--border-medium);
  border-radius: 16px;
  box-shadow: 0 24px 60px -8px rgba(0, 0, 0, 0.35);
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.aic-modal-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 18px 20px 14px;
  border-bottom: 1px solid var(--border);
}
.aic-modal-title {
  margin: 0;
  font-family: var(--font-display);
  font-size: 16px;
  font-weight: 700;
  letter-spacing: -0.01em;
  color: var(--text);
}
.aic-modal-close {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  border-radius: 8px;
  background: transparent;
  color: var(--text-muted);
}
.aic-modal-close:hover { background: rgba(var(--on-surface-rgb), 0.07); color: var(--text); }

.aic-modal-body {
  padding: 18px 20px;
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.aic-modal-foot {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 10px;
  padding: 14px 20px;
  border-top: 1px solid var(--border);
}

.aic-field-label {
  display: block;
  font-size: 12.5px;
  font-weight: 600;
  color: var(--text-muted);
  margin-bottom: 4px;
}
.aic-access-fieldset {
  border: 0;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.aic-access-fieldset legend { font-size: 12.5px; font-weight: 600; color: var(--text-muted); margin-bottom: 8px; }
.aic-radio {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 12px 14px;
  border: 1px solid var(--border-medium);
  border-radius: 10px;
  cursor: pointer;
  transition: border-color 0.15s, background 0.15s;
}
.aic-radio:has(input:checked) {
  border-color: var(--brand);
  background: rgba(14, 165, 233, 0.04);
}
.aic-radio input[type="radio"] { margin-top: 2px; flex-shrink: 0; accent-color: var(--brand); }
.aic-radio-label {
  display: flex;
  flex-direction: column;
  gap: 2px;
  font-size: 13px;
}
.aic-radio-label strong { color: var(--text); font-weight: 600; }
.aic-radio-label span { font-size: 12px; color: var(--text-muted); line-height: 1.4; }
.aic-radio input:disabled { opacity: 0.6; }
.aic-radio:has(input:disabled) { opacity: 0.6; cursor: not-allowed; }

.aic-modal-error { margin: 0; font-size: 12.5px; font-weight: 500; color: #c62828; }
:root[data-theme="dark"] .aic-modal-error { color: #f87171; }

.aic-create-btn {
  height: 38px;
  padding: 0 18px;
  border-radius: 9px;
  background: var(--brand);
  color: #fff;
  font-size: 14px;
  font-weight: 600;
}
.aic-create-btn:disabled { opacity: 0.5; cursor: not-allowed; }

/* ── Amber warning banner ─────────────────────────────────────────────── */
.aic-amber-warn {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 11px 14px;
  border-radius: 9px;
  background: rgba(245, 158, 11, 0.12);
  border: 1px solid rgba(245, 158, 11, 0.35);
  color: #92400e;
  font-size: 13px;
  font-weight: 600;
}
:root[data-theme="dark"] .aic-amber-warn { color: #fcd34d; }
.aic-amber-warn svg { color: #d97706; flex-shrink: 0; }

/* ── Raw token display ────────────────────────────────────────────────── */
.aic-raw-token-wrap {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 12px;
  border: 1px solid var(--border-medium);
  border-radius: 9px;
  background: rgba(var(--on-surface-rgb), 0.04);
}
.aic-raw-token {
  flex: 1;
  font-family: var(--font-mono);
  font-size: 12px;
  color: var(--text);
  word-break: break-all;
  line-height: 1.5;
}
.aic-token-copy-btn {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  flex-shrink: 0;
  height: 30px;
  padding: 0 10px;
  border: 1px solid var(--border-strong);
  border-radius: 7px;
  font-size: 12px;
  font-weight: 600;
  color: var(--text);
  background: transparent;
}
.aic-token-copy-btn:hover { background: rgba(var(--on-surface-rgb), 0.06); }

/* ── Responsive ───────────────────────────────────────────────────────── */
@media (max-width: 640px) {
  .aic-token-row { flex-wrap: wrap; }
  .aic-token-dates { min-width: auto; }
}
</style>
