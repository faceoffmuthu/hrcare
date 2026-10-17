/* Small compatibility layer for the existing HRs Portal UI. All privileged
   reads and writes go through the Node API; no database credential is sent
   to the browser. */
export function createClient(baseUrl) {
  const root = String(baseUrl || '').replace(/\/$/, '');
  const request = async (path, options = {}) => {
    const response = await fetch(`${root}${path}`, { credentials: 'include', ...options, headers: { ...(options.body instanceof FormData ? {} : { 'Content-Type': 'application/json' }), ...(options.headers || {}) } });
    let body = {};
    try { body = await response.json(); } catch {}
    if (!response.ok) return { data: null, error: Object.assign(new Error(body.error || 'Request failed.'), { status: response.status }) };
    return { data: body, error: null };
  };
  const call = (path, body) => request(path, { method: 'POST', body: JSON.stringify(body ?? {}) });
  const auth = {
    onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
    getSession: async () => { const r = await request('/api/auth/me'); return { data: { session: r.data?.user ? { user: userShape(r.data.user) } : null }, error: r.error?.status === 401 ? null : r.error }; },
    getUser: async () => { const r = await request('/api/auth/me'); return { data: { user: r.data?.user ? userShape(r.data.user) : null }, error: r.error }; },
    signInWithPassword: async ({ email, password, portal = 'public' }) => { const r = await call('/api/auth/login', { email, password, portal }); return { data: { user: r.data?.user ? userShape(r.data.user) : null }, error: r.error }; },
    signUp: async ({ email, password, options }) => { const d=options?.data||{}; let body={ email,password,fullName:d.full_name,role:d.requested_role,accountType:d.account_type,companyName:d.company_name,companyWebsite:d.company_website,acceptedTerms:true }; if(d.resume_file){const form=new FormData(); for(const [key,value] of Object.entries(body))if(value!==undefined&&value!==null)form.append(key,typeof value==='boolean'?String(value):String(value)); form.append('resume',d.resume_file,d.resume_file.name); body=form;} const r = await request('/api/auth/register', { method:'POST', body:body instanceof FormData?body:JSON.stringify(body) }); return { data: { user: null, session: null, message: r.data?.message, verificationUrl: r.data?.verificationUrl }, error: r.error }; },
    acceptInvite: async ({ token, password }) => call('/api/auth/accept-invite', { token, password }),
    signOut: async () => request('/api/auth/logout', { method: 'POST' }),
    resetPasswordForEmail: async (email) => call('/api/auth/forgot-password', { email }),
    resend: async ({ email }) => call('/api/auth/resend-verification', { email }),
    updateUser: async ({ password }) => { const token = new URLSearchParams(location.search).get('token'); return token ? call('/api/auth/reset-password', { password, token }) : call('/api/auth/change-password', { password }); },
    getUserIdentities: async () => { const r = await request('/api/auth/identities'); return { data: { identities: r.data?.identities || [] }, error: r.error }; },
    signInWithOAuth: async ({ provider, options = {} }) => { const params = new URLSearchParams(); if (options.queryParams?.portal) params.set('portal', options.queryParams.portal); location.assign(`${root}/api/oauth/${provider === 'linkedin_oidc' ? 'linkedin' : provider}/start${params.size ? `?${params}` : ''}`); return { data: {}, error: null }; },
    linkIdentity: async ({ provider }) => { location.assign(`${root}/api/oauth/${provider === 'linkedin_oidc' ? 'linkedin' : provider}/start?link=1`); return { data: {}, error: null }; },
    unlinkIdentity: async (identity) => request(`/api/auth/identities/${encodeURIComponent(identity.provider)}`, { method: 'DELETE' }),
    mfa: {
      listFactors: async () => { const r = await request('/api/admin/mfa/status'); return { data: { totp: r.data?.enrolled ? [{ id: 'totp', status: 'verified' }] : [] }, error: r.error }; },
      enroll: async () => { const r = await call('/api/admin/mfa/enroll'); return { data: r.data ? { id: 'totp', totp: { secret: r.data.secret, uri: r.data.uri, qr_code: r.data.qrCode } } : null, error: r.error }; },
      challenge: async () => ({ data: { id: 'totp' }, error: null }),
      verify: async ({ code }) => call('/api/admin/mfa/verify', { code }),
      unenroll: async () => ({ data: {}, error: null })
    }
  };
  const functions = { invoke: async (name, { body } = {}) => name === 'admin-api' ? request('/api/admin', { method: 'POST', body: JSON.stringify(body || {}) }) : name === 'delete-account' ? request('/api/account', { method: 'DELETE' }) : ({ data: null, error: new Error('Unknown API operation.') }) };
  const storage = { from: () => ({
    upload: async (path, file) => { const form = new FormData(); form.append('resume', file, file.name); const r = await request('/api/resumes', { method: 'POST', body: form }); return { data: r.data ? { path: r.data.key } : null, error: r.error }; },
    remove: async (paths) => { for (const path of paths || []) { const r = await request(`/api/resumes?key=${encodeURIComponent(path)}`, { method: 'DELETE' }); if (r.error) return r; } return { data: [], error: null }; },
    createSignedUrl: async (path) => { const r = await request(`/api/resumes?key=${encodeURIComponent(path)}`); return { data: r.data ? { signedUrl: r.data.url } : null, error: r.error }; }
  }) };
  return { auth, functions, storage, from: table => new Query(root, request, table), rpc: async (name, args) => name === 'accept_registration_terms' ? call('/api/auth/accept-terms', { fullName: args.p_full_name, role: args.p_requested_role, termsVersion: args.p_terms_version, accepted: args.p_accepted }).then(r => ({ data: r.data?.data || null, error: r.error })) : ({ data: null, error: new Error('Unknown API operation.') }) };
}

function userShape(user) { return { ...user, user_metadata: user.user_metadata || { full_name: user.full_name }, email_confirmed_at: user.email_confirmed_at }; }

class Query {
  constructor(root, request, table) { this.root = root; this.request = request; this.table = table; this.operation = 'select'; this.filters = []; this.values = null; this.columns = '*'; }
  select(columns = '*') { this.columns = columns; if (this.operation === 'select') this.operation = 'select'; return this; }
  insert(values) { this.operation = 'insert'; this.values = values; return this; }
  update(values) { this.operation = 'update'; this.values = values; return this; }
  eq(column, value) { this.filters.push([column, value]); return this; }
  maybeSingle() { this.one = true; return this.execute(); }
  single() { this.one = true; this.required = true; return this.execute(); }
  then(resolve, reject) { return this.execute().then(resolve, reject); }
  async execute() {
    const r = await this.request('/api/data', { method: 'POST', body: JSON.stringify({ table: this.table, operation: this.operation, columns: this.columns, values: this.values, filters: this.filters, single: this.one }) });
    let data = r.data?.data ?? null;
    if (this.one && Array.isArray(data)) data = data[0] || null;
    if (this.required && !data && !r.error) return { data: null, error: new Error('Record not found.') };
    return { data, error: r.error };
  }
}
