<script setup lang="ts">
// OAuth 2.1 consent screen for MCP connectors (claude.ai / ChatGPT).
// GET params: client_id, redirect_uri, state, code_challenge,
// code_challenge_method, scope, resource?
//
// Flow:
//   1. Validate PKCE params are present + S256 (else hard error, no redirect).
//   2. Fetch /api/me — if no session, bounce to /login with next= back here.
//   3. Fetch /api/oauth/client-info to get the client name + confirm the
//      redirect_uri is registered.
//   4. Authorize → POST /api/oauth/authorize-decision → follow {redirect}.
//   5. Deny → redirect to redirect_uri?error=access_denied&state=.
definePageMeta({ layout: false })

useHead({
  title: 'Authorize · Snappi',
  meta: [{ name: 'robots', content: 'noindex' }],
})

const route = useRoute()

const clientId = computed(() => (route.query.client_id as string) || '')
const redirectUri = computed(() => (route.query.redirect_uri as string) || '')
const state = computed(() => (route.query.state as string) || '')
const codeChallenge = computed(() => (route.query.code_challenge as string) || '')
const codeChallengeMethod = computed(() => (route.query.code_challenge_method as string) || '')
const scope = computed(() => (route.query.scope as string) || 'read write')

const scopeList = computed(() => {
  const parts = scope.value.split(/\s+/).map(s => s.trim()).filter(Boolean)
  const items: string[] = ['Read your boards and tasks']
  if (parts.includes('write')) items.push('Create and update items')
  return items
})

const loading = ref(true)
const submitting = ref(false)
const fatalError = ref<string | null>(null)
const clientName = ref<string>('An application')
const userEmail = ref<string>('')

onMounted(async () => {
  // Guard PKCE first — never proceed without a valid S256 challenge.
  if (!clientId.value || !redirectUri.value) {
    fatalError.value = 'Invalid authorization request: missing client_id or redirect_uri.'
    loading.value = false
    return
  }
  if (!codeChallenge.value || (codeChallengeMethod.value && codeChallengeMethod.value !== 'S256')) {
    fatalError.value = 'This application must use PKCE with the S256 method. Authorization cannot continue.'
    loading.value = false
    return
  }

  // Session check.
  try {
    const me = await $fetch<{ user: { email: string } | null }>('/api/me', { ignoreResponseError: true })
    if (!me?.user) {
      const next = route.fullPath
      await navigateTo(`/login?redirect=${encodeURIComponent(next)}`, { external: true })
      return
    }
    userEmail.value = me.user.email
  } catch {
    const next = route.fullPath
    await navigateTo(`/login?redirect=${encodeURIComponent(next)}`, { external: true })
    return
  }

  // Client + redirect_uri validation.
  try {
    const info = await $fetch<{ client_name?: string, redirect_uri_valid?: boolean, error?: string }>(
      '/api/oauth/client-info',
      { params: { client_id: clientId.value, redirect_uri: redirectUri.value }, ignoreResponseError: true },
    )
    if (!info || info.error || !info.client_name) {
      fatalError.value = 'Unknown application. This authorization request cannot be completed.'
      loading.value = false
      return
    }
    if (!info.redirect_uri_valid) {
      fatalError.value = 'The redirect URL for this application is not registered. Authorization cannot continue.'
      loading.value = false
      return
    }
    clientName.value = info.client_name
  } catch {
    fatalError.value = 'Could not verify the application. Please try again.'
    loading.value = false
    return
  }

  loading.value = false
})

async function authorize() {
  submitting.value = true
  try {
    const res = await $fetch<{ redirect?: string, error?: string }>('/api/oauth/authorize-decision', {
      method: 'POST',
      body: {
        client_id: clientId.value,
        redirect_uri: redirectUri.value,
        state: state.value,
        code_challenge: codeChallenge.value,
        code_challenge_method: codeChallengeMethod.value || 'S256',
        scope: scope.value,
      },
    })
    if (res?.redirect) {
      window.location.href = res.redirect
      return
    }
    fatalError.value = res?.error || 'Authorization failed. Please try again.'
  } catch (e: unknown) {
    const msg = (e as { data?: { error_description?: string, error?: string } })?.data
    fatalError.value = msg?.error_description || msg?.error || 'Authorization failed. Please try again.'
  } finally {
    submitting.value = false
  }
}

function deny() {
  // Redirect back to the connector with an OAuth error, preserving state.
  try {
    const url = new URL(redirectUri.value)
    url.searchParams.set('error', 'access_denied')
    if (state.value) url.searchParams.set('state', state.value)
    window.location.href = url.toString()
  } catch {
    fatalError.value = 'Request denied.'
  }
}
</script>

<template>
  <div class="oauth-shell">
    <section class="oauth-card">
      <NuxtLink to="/" class="oauth-brand" aria-label="Snappi home">
        <SnappiLogo :size="30" />
        <span>Snappi</span>
      </NuxtLink>

      <template v-if="loading">
        <div class="oauth-waiting" role="status" aria-live="polite">
          <svg class="oauth-spin" width="22" height="22" viewBox="0 0 24 24" fill="none">
            <circle cx="12" cy="12" r="10" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-dasharray="40 60" />
          </svg>
          <span>Checking authorization request…</span>
        </div>
      </template>

      <template v-else-if="fatalError">
        <h1 class="oauth-title">Can't authorize</h1>
        <p class="oauth-error" role="alert">{{ fatalError }}</p>
      </template>

      <template v-else>
        <h1 class="oauth-title"><strong>{{ clientName }}</strong> wants to access your Snappi account</h1>
        <p class="oauth-sub">Signed in as <strong>{{ userEmail }}</strong></p>

        <ul class="oauth-scopes">
          <li v-for="s in scopeList" :key="s">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path d="M20 6 9 17l-5-5" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
            </svg>
            <span>{{ s }}</span>
          </li>
        </ul>

        <div class="oauth-actions">
          <button type="button" class="oauth-authorize" :disabled="submitting" @click="authorize">
            <span v-if="!submitting">Authorize</span>
            <span v-else>Authorizing…</span>
          </button>
          <button type="button" class="oauth-deny" :disabled="submitting" @click="deny">Deny</button>
        </div>

        <p class="oauth-note">
          Authorizing grants <strong>{{ clientName }}</strong> an access token scoped to your account.
          You can revoke it any time from Settings.
        </p>
      </template>
    </section>
  </div>
</template>

<style scoped>
.oauth-shell { display: flex; align-items: center; justify-content: center; min-height: 100dvh; background: #f7f8fa; color: var(--text); padding: 24px; }
.oauth-card {
  width: 100%; max-width: 420px; background: #ffffff;
  border: 1px solid var(--border); border-radius: 14px;
  box-shadow: 0 10px 40px rgba(0,0,0,0.06);
  padding: 36px 32px;
  display: flex; flex-direction: column;
}
.oauth-brand { display: inline-flex; align-items: center; gap: 10px; font-family: var(--font-display); font-weight: 800; font-size: 19px; letter-spacing: -0.03em; color: var(--text); align-self: center; margin-bottom: 28px; }
.oauth-title { font-family: var(--font-display); font-weight: 700; font-size: 21px; line-height: 1.3; letter-spacing: -0.01em; margin: 0 0 6px; text-align: center; }
.oauth-title strong { color: var(--brand); font-weight: 700; }
.oauth-sub { text-align: center; color: var(--text-muted); font-size: 14px; margin: 0 0 24px; }
.oauth-scopes { list-style: none; margin: 0 0 28px; padding: 16px 18px; background: #fafbfc; border: 1px solid var(--border); border-radius: 10px; display: flex; flex-direction: column; gap: 12px; }
.oauth-scopes li { display: flex; align-items: center; gap: 10px; font-size: 14px; color: var(--text); }
.oauth-scopes svg { flex-shrink: 0; color: var(--brand); }
.oauth-actions { display: flex; flex-direction: column; gap: 10px; }
.oauth-authorize { height: 48px; width: 100%; border-radius: 8px; background: var(--brand); color: #fff; font-weight: 600; font-size: 15px; border: 0; box-shadow: 0 1px 0 rgba(255,255,255,0.18) inset, 0 0 0 1px var(--brand-deep) inset; transition: filter 0.15s ease; }
.oauth-authorize:hover:not(:disabled) { filter: brightness(0.95); }
.oauth-authorize:disabled { opacity: 0.7; cursor: not-allowed; }
.oauth-deny { height: 48px; width: 100%; border-radius: 8px; background: #fff; color: var(--text); font-weight: 500; font-size: 15px; border: 1px solid var(--border-strong); transition: background 0.15s ease; }
.oauth-deny:hover:not(:disabled) { background: #fafafa; }
.oauth-deny:disabled { opacity: 0.7; cursor: not-allowed; }
.oauth-note { margin: 20px 0 0; text-align: center; font-size: 12px; line-height: 1.5; color: var(--text-subtle); }
.oauth-error { text-align: center; color: #c62828; font-size: 14px; line-height: 1.5; margin: 8px 0 0; }
.oauth-waiting { display: flex; align-items: center; justify-content: center; gap: 12px; padding: 32px 0; color: var(--text-muted); font-size: 14px; }
.oauth-waiting .oauth-spin { color: var(--brand); animation: oauth-spin 0.85s linear infinite; }
@keyframes oauth-spin { to { transform: rotate(360deg); } }
</style>
