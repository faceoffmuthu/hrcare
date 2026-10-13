import crypto from 'node:crypto';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import 'dotenv/config';
import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import rateLimit from 'express-rate-limit';
import { authenticator } from 'otplib';
import QRCode from 'qrcode';
import nodemailer from 'nodemailer';
import pg from 'pg';
import multer from 'multer';
import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { canAccessLoginPortal, LOGIN_PORTALS } from './portal-access.js';
import { extractResumeText, rankCareerJobs, requestCareerDraft } from './career-copilot.js';

const { Pool } = pg;
const app = express();
const origin = process.env.APP_ORIGIN;
const production = process.env.NODE_ENV === 'production';
const cookieName = process.env.COOKIE_NAME || 'hrs_session';
const sessionDays = 14;
const encryptionKey = crypto.createHash('sha256').update(process.env.SESSION_SECRET || 'local-only-session-secret-change-me').digest();
if (production && (!process.env.SESSION_SECRET || process.env.SESSION_SECRET.length < 32)) throw new Error('SESSION_SECRET must contain at least 32 characters in production.');
if (production) {
  const missing=['APP_ORIGIN','DATABASE_URL','EMAIL_FROM','S3_BUCKET','S3_ACCESS_KEY_ID','S3_SECRET_ACCESS_KEY'].filter(key=>!process.env[key]);
  if(!process.env.RESEND_API_KEY&&!process.env.SMTP_HOST)missing.push('RESEND_API_KEY or SMTP_HOST');
  if(missing.length)throw new Error(`Missing required production configuration: ${missing.join(', ')}`);
  if(!process.env.APP_ORIGIN.startsWith('https://'))throw new Error('APP_ORIGIN must use HTTPS in production.');
}
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : undefined, max: Number(process.env.PG_POOL_MAX || (process.env.NETLIFY ? 2 : 10)) });
let registrationResumeSchemaReady;
const ensureRegistrationResumeSchema = () => registrationResumeSchemaReady ||= pool.query(`create table if not exists registration_resume_staging (user_id uuid primary key references app_users(id) on delete cascade, resume_key text not null, resume_name text not null, expires_at timestamptz not null default now() + interval '7 days', created_at timestamptz not null default now())`).catch(error=>{registrationResumeSchemaReady=undefined;throw error});
const s3 = process.env.S3_BUCKET ? new S3Client({ region: process.env.S3_REGION || 'auto', endpoint: process.env.S3_ENDPOINT || undefined, credentials: process.env.S3_ACCESS_KEY_ID ? { accessKeyId: process.env.S3_ACCESS_KEY_ID, secretAccessKey: process.env.S3_SECRET_ACCESS_KEY } : undefined }) : null;
const localResumeRoot = !production && process.env.LOCAL_RESUME_DIR ? path.resolve(process.env.LOCAL_RESUME_DIR) : null;
const mailer = process.env.SMTP_HOST ? nodemailer.createTransport({ host: process.env.SMTP_HOST, port: Number(process.env.SMTP_PORT || 587), secure: Number(process.env.SMTP_PORT) === 465, auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASSWORD } : undefined }) : null;
const b64url = (input) => Buffer.from(input).toString('base64url');
const digest = (input) => crypto.createHash('sha256').update(input).digest('hex');
const opaqueToken = () => b64url(crypto.randomBytes(32));
const passwordHash = async (password) => { const salt=crypto.randomBytes(16);const derived=await promisify(crypto.scrypt)(password,salt,64,{N:32768,r:8,p:1,maxmem:64*1024*1024});return `scrypt$${salt.toString('base64url')}$${Buffer.from(derived).toString('base64url')}`; };
const passwordMatches = async (password,stored) => { try { const [algorithm,salt,expected]=String(stored).split('$');if(algorithm!=='scrypt')return false;const got=Buffer.from(await promisify(crypto.scrypt)(password,Buffer.from(salt,'base64url'),64,{N:32768,r:8,p:1,maxmem:64*1024*1024}));const want=Buffer.from(expected,'base64url');return got.length===want.length&&crypto.timingSafeEqual(got,want); } catch { return false; } };
const encryptSecret = (value) => { const iv=crypto.randomBytes(12),cipher=crypto.createCipheriv('aes-256-gcm',encryptionKey,iv),encrypted=Buffer.concat([cipher.update(value,'utf8'),cipher.final()]);return `${b64url(iv)}.${b64url(cipher.getAuthTag())}.${b64url(encrypted)}`; };
const decryptSecret = (value) => { const [iv,tag,data]=value.split('.').map(x=>Buffer.from(x,'base64url'));const decipher=crypto.createDecipheriv('aes-256-gcm',encryptionKey,iv);decipher.setAuthTag(tag);return Buffer.concat([decipher.update(data),decipher.final()]).toString('utf8'); };
const clean = (x, max = 500) => typeof x === 'string' ? x.trim().slice(0, max) : '';
const emailOk = (x) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(x) && x.length <= 254;
const sendMail = async (to, subject, text) => {
  if (process.env.RESEND_API_KEY) {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: process.env.EMAIL_FROM, to: [to], subject, text }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`Email provider rejected the message (HTTP ${response.status}).`);
    return;
  }
  if (!mailer) throw new Error('Email delivery is not configured.');
  await mailer.sendMail({ from: process.env.EMAIL_FROM, to, subject, text });
};
const webUrl = (path) => `${origin || 'http://localhost:4173'}${path}`;
const hasResumeStorage = () => Boolean(s3 || localResumeRoot);
const localResumePath = (key) => {
  if (!localResumeRoot || !/^[0-9a-f-]{36}\/[a-zA-Z0-9-]+\.(pdf|doc|docx)$/i.test(key)) return null;
  const resolved = path.resolve(localResumeRoot, key);
  return resolved.startsWith(`${localResumeRoot}${path.sep}`) ? resolved : null;
};
const saveResume = async (key, buffer, contentType) => {
  if (s3) return s3.send(new PutObjectCommand({ Bucket: process.env.S3_BUCKET, Key: key, Body: buffer, ContentType: contentType, Metadata: { owner: key.split('/')[0] } }));
  const file = localResumePath(key);
  if (!file) throw new Error('Local resume storage is not configured.');
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await writeFile(file, buffer, { mode: 0o600 });
};
const readResume = async (key) => {
  if (s3) {
    const file = await s3.send(new GetObjectCommand({ Bucket: process.env.S3_BUCKET, Key: key }));
    return Buffer.from(await file.Body.transformToByteArray());
  }
  const file = localResumePath(key);
  if (!file) throw new Error('Local resume storage is not configured.');
  return readFile(file);
};
const deleteResume = async (key) => {
  if (s3) return s3.send(new DeleteObjectCommand({ Bucket: process.env.S3_BUCKET, Key: key }));
  const file = localResumePath(key);
  if (file) await unlink(file).catch((error) => { if (error.code !== 'ENOENT') throw error; });
};
const setSessionCookie = (res, token) => res.cookie(cookieName, token, { httpOnly: true, secure: production, sameSite: production ? 'none' : 'lax', path: '/', maxAge: sessionDays * 86400000 });
const clearSessionCookie = (res) => res.clearCookie(cookieName, { httpOnly: true, secure: production, sameSite: production ? 'none' : 'lax', path: '/' });

app.disable('x-powered-by');
app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
app.use(cors({ origin: origin || 'http://localhost:4173', credentials: true, methods: ['GET','POST','PATCH','DELETE','OPTIONS'], allowedHeaders: ['Content-Type'] }));
app.use(express.json({ limit: '1mb' }));
app.use(cookieParser());
app.use('/api/auth', rateLimit({ windowMs: 15 * 60 * 1000, limit: 50, standardHeaders: 'draft-7', legacyHeaders: false }));
app.use('/api/admin/mfa/verify', rateLimit({ windowMs: 15 * 60 * 1000, limit: 8, standardHeaders: 'draft-7', legacyHeaders: false }));
app.use('/api/admin', rateLimit({ windowMs: 15 * 60 * 1000, limit: 120, standardHeaders: 'draft-7', legacyHeaders: false }));
app.use('/api', async (req, res, next) => {
  res.setHeader('Cache-Control','no-store');
  try {
    const raw = req.cookies?.[cookieName];
    if (raw) {
      const { rows } = await pool.query(`select s.user_id,s.mfa_verified,s.expires_at,u.email,u.email_verified_at,p.full_name,p.account_role,p.account_status,p.onboarding_completed_at from auth_sessions s join app_users u on u.id=s.user_id join user_profiles p on p.id=u.id where s.token_hash=$1 and s.expires_at>now()`, [digest(raw)]);
      req.auth = rows[0] || null;
      if (!req.auth) clearSessionCookie(res);
    }
    next();
  } catch (err) { next(err); }
});
const requireAuth = (req, res, next) => req.auth ? next() : res.status(401).json({ error: 'Sign in again to continue.' });
const requireVerified = (req, res, next) => req.auth?.email_verified_at ? next() : res.status(403).json({ error: 'Verify your email before continuing.' });
const requireAdmin = async (req, res, next) => {
  if (!req.auth?.email_verified_at || !req.auth?.mfa_verified) return res.status(403).json({ error: 'Verified platform admin access with MFA is required.' });
  try {
    const { rows } = await pool.query(`select role from platform_admins where user_id=$1 and role in ('admin','super_admin') and status='active'`, [req.auth.user_id]);
    if (!rows.length || req.auth.account_status === 'suspended') return res.status(403).json({ error: 'This account is not assigned active platform admin access.' });
    req.platformAdminRole = rows[0].role;
    next();
  } catch (e) { next(e); }
};
const createSession = async (userId, res, mfaVerified = false) => {
  const token = opaqueToken();
  await pool.query(`insert into auth_sessions(token_hash,user_id,mfa_verified,expires_at) values($1,$2,$3,now()+interval '${sessionDays} days')`, [digest(token), userId, mfaVerified]);
  setSessionCookie(res, token);
};
const createEmailToken = async (userId, purpose) => {
  const token = opaqueToken();
  await pool.query('delete from auth_tokens where user_id=$1 and purpose=$2', [userId, purpose]);
  await pool.query(`insert into auth_tokens(token_hash,user_id,purpose,expires_at) values($1,$2,$3,now()+interval '1 day')`, [digest(token), userId, purpose]);
  return token;
};

app.get('/api/health', async (_req, res) => {
  try { await pool.query('select 1'); res.json({ status: 'ok', service: 'hrs-portal-api' }); }
  catch { res.status(503).json({ status: 'unavailable' }); }
});

const registrationUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024, files: 1 }, fileFilter: (_req,file,cb) => /\.(pdf|doc|docx)$/i.test(file.originalname) ? cb(null,true) : cb(Object.assign(new Error('Choose a PDF, DOC or DOCX resume.'),{status:400})) });
app.post('/api/auth/register', registrationUpload.single('resume'), async (req, res, next) => {
  const fullName = clean(req.body?.fullName, 120), email = clean(req.body?.email, 254).toLowerCase(), password = req.body?.password;
  const accountType = req.body?.accountType === 'company' ? 'company' : 'member';
  const role = accountType === 'company' ? 'recruiter' : req.body?.role;
  const resumeFile = req.file;
  const companyName = clean(req.body?.companyName, 160), companyWebsite = clean(req.body?.companyWebsite, 300);
  let validWebsite = true;
  if (companyWebsite) { try { const url = new URL(companyWebsite); validWebsite = ['http:', 'https:'].includes(url.protocol) && Boolean(url.hostname.includes('.')); } catch { validWebsite = false; } }
  if (!fullName || !emailOk(email) || typeof password !== 'string' || password.length < 12 || password.length > 1024 || !['candidate','recruiter'].includes(role) || (accountType === 'company' && companyName.length < 2) || !validWebsite || req.body?.acceptedTerms !== 'true' && req.body?.acceptedTerms !== true || role === 'candidate' && !resumeFile) return res.status(400).json({ error: role === 'candidate' && !resumeFile ? 'Upload a PDF, DOC or DOCX resume up to 5 MB to create a candidate account.' : 'Check your name, email, password, account type, company details, and terms acceptance.' });
  if (role === 'candidate' && !hasResumeStorage()) return res.status(503).json({ error: 'Private resume storage is not configured, so candidate registration cannot save your resume yet.' });
  let storedResumeKey;
  const client = await pool.connect();
  try {
    if(role==='candidate')await ensureRegistrationResumeSchema();
    await client.query('begin');
    const hash = await passwordHash(password);
    const user = (await client.query('insert into app_users(email,password_hash) values($1,$2) returning id,email', [email, hash])).rows[0];
    await client.query(`insert into user_profiles(id,full_name,account_role,account_status) values($1,$2,$3,'pending_terms')`, [user.id, fullName, role]);
    if (accountType === 'company') {
      const company = (await client.query(`insert into companies(created_by,name,website,verification_status) values($1,$2,$3,'pending') returning id`, [user.id, companyName, companyWebsite || null])).rows[0];
      await client.query(`insert into company_memberships(company_id,user_id,role,status) values($1,$2,'company_admin','invited')`, [company.id, user.id]);
    }
    if (role === 'candidate') {
      const ext = resumeFile.originalname.toLowerCase().match(/\.(pdf|doc|docx)$/)?.[1];
      const mimeByExt = { pdf:'application/pdf', doc:'application/msword', docx:'application/vnd.openxmlformats-officedocument.wordprocessingml.document' };
      if (resumeFile.mimetype && resumeFile.mimetype !== 'application/octet-stream' && resumeFile.mimetype !== mimeByExt[ext]) { const error = new Error('The resume file type does not match its extension.'); error.status = 400; throw error; }
      storedResumeKey = `${user.id}/reg-${crypto.randomBytes(12).toString('hex')}.${ext}`;
      await saveResume(storedResumeKey, resumeFile.buffer, mimeByExt[ext]);
      await client.query('insert into registration_resume_staging(user_id,resume_key,resume_name) values($1,$2,$3)', [user.id, storedResumeKey, resumeFile.originalname.slice(0, 200)]);
    }
    const token = opaqueToken();
    await client.query(`insert into auth_tokens(token_hash,user_id,purpose,expires_at) values($1,$2,'verify_email',now()+interval '1 day')`, [digest(token), user.id]);
    await client.query('commit');
    let emailSent = true;
    try { await sendMail(email, 'Verify your HRs Portal email', `Use this link to verify your email: ${webUrl(`/?auth=verify&token=${encodeURIComponent(token)}`)}\nThis link expires in 24 hours.`); } catch (mailError) { emailSent = false; console.error('Verification email delivery failed:', mailError.message); }
    const verificationUrl = !emailSent && !production && localResumeRoot ? webUrl(`/?auth=verify&token=${encodeURIComponent(token)}`) : undefined;
    const message = accountType === 'company'
      ? emailSent ? 'Company request received. Verify your email; company and recruiter access stay pending until HRs Portal reviews them.' : verificationUrl ? 'Company request received. Use the local verification link; company and recruiter access stay pending until HRs Portal reviews them.' : 'Company request received, but the verification email could not be sent. Access remains pending until HRs Portal reviews the company.'
      : emailSent ? 'Check your inbox for an email verification link.' : verificationUrl ? 'Local mode: use the verification link below to activate this account.' : 'Your account was created, but the verification email could not be sent. Use Resend verification after email delivery is configured.';
    res.status(201).json({ message, ...(verificationUrl ? { verificationUrl } : {}) });
  } catch (e) { await client.query('rollback'); if (storedResumeKey) await deleteResume(storedResumeKey).catch(()=>{}); if (e.code === '23505') return res.status(409).json({ error: 'If this address can be registered, check its inbox for next steps.' }); next(e); }
  finally { client.release(); }
});
app.post('/api/auth/login', async (req, res, next) => {
  try {
    const email = clean(req.body?.email, 254).toLowerCase(), password = req.body?.password;
    const portal = clean(req.body?.portal, 24) || 'public';
    if (!LOGIN_PORTALS.includes(portal)) return res.status(400).json({ error: 'Choose a valid sign-in portal.' });
    const { rows } = await pool.query(`select u.id,u.password_hash,u.email_verified_at,p.account_role,p.account_status,a.role as platform_role,a.status as platform_status,m.role as membership_role,m.status as membership_status,c.verification_status as company_status
      from app_users u join user_profiles p on p.id=u.id
      left join platform_admins a on a.user_id=u.id
      left join lateral (select m.company_id,m.role,m.status from company_memberships m join companies co on co.id=m.company_id where m.user_id=u.id order by (m.status='active' and co.verification_status='verified' and m.role='company_admin') desc,m.created_at desc limit 1) m on true
      left join companies c on c.id=m.company_id where u.email=$1`, [email]);
    if (!rows[0]?.password_hash || !(await passwordMatches(String(password || ''),rows[0].password_hash))) return res.status(401).json({ error: 'Email or password could not be confirmed.' });
    if (!canAccessLoginPortal(portal, rows[0])) return res.status(403).json({ error: 'This account is not assigned to that sign-in portal. Use the correct portal or contact HRs Portal support.' });
    await pool.query('update app_users set last_sign_in_at=now() where id=$1', [rows[0].id]);
    const isPlatformAdmin = ['admin', 'super_admin'].includes(rows[0].platform_role) && rows[0].platform_status === 'active';
    await createSession(rows[0].id, res, !isPlatformAdmin);
    const profile = (await pool.query('select id,full_name,account_role,account_status,onboarding_completed_at from user_profiles where id=$1', [rows[0].id])).rows[0];
    res.json({ user: { id: rows[0].id, email, email_confirmed_at: rows[0].email_verified_at }, profile });
  } catch (e) { next(e); }
});
app.get('/api/auth/me', requireAuth, async (req, res) => {
  const { rows } = await pool.query(`select u.id,u.email,u.email_verified_at as email_confirmed_at,p.id as profile_id,p.full_name,p.account_role,p.account_status,p.onboarding_completed_at from app_users u join user_profiles p on p.id=u.id where u.id=$1`, [req.auth.user_id]);
  const { rows: admin } = await pool.query(`select role,status from platform_admins where user_id=$1`, [req.auth.user_id]);
  const { rows: mfa } = await pool.query(`select verified_at from user_mfa where user_id=$1`, [req.auth.user_id]);
  res.json({ user: rows[0] ? { id: rows[0].id, email: rows[0].email, email_confirmed_at: rows[0].email_confirmed_at } : null, profile: rows[0] || null, admin: admin[0] || null, mfaEnrolled: Boolean(mfa[0]?.verified_at), mfaVerified: Boolean(req.auth.mfa_verified) });
});
app.get('/api/auth/identities', requireAuth, async (req,res)=>{const {rows}=await pool.query('select provider,provider_email from oauth_accounts where user_id=$1 order by created_at',[req.auth.user_id]);res.json({identities:rows.map((x,i)=>({id:String(i),provider:x.provider,identity_data:{email:x.provider_email}}))});});
app.delete('/api/auth/identities/:provider', requireAuth, async (req,res)=>{const provider=clean(req.params.provider,40);const {rows}=await pool.query('select password_hash,(select count(*) from oauth_accounts where user_id=$1) as providers from app_users where id=$1',[req.auth.user_id]);if(!rows[0]||(!rows[0].password_hash&&Number(rows[0].providers)<=1))return res.status(400).json({error:'Add another sign-in method before disconnecting this one.'});await pool.query('delete from oauth_accounts where user_id=$1 and provider=$2',[req.auth.user_id,provider]);res.json({ok:true});});
app.post('/api/auth/logout', async (req, res, next) => { try { const raw=req.cookies?.[cookieName]; if(raw)await pool.query('delete from auth_sessions where token_hash=$1',[digest(raw)]); clearSessionCookie(res); res.json({ok:true}); } catch(e) { next(e); } });
app.post('/api/auth/verify-email', async (req, res) => {
  const token = clean(req.body?.token, 200);
  const { rows } = await pool.query(`delete from auth_tokens where token_hash=$1 and purpose='verify_email' and expires_at>now() returning user_id`, [digest(token)]);
  if (!rows[0]) return res.status(400).json({ error: 'This email link is invalid or expired.' });
  await pool.query(`update app_users set email_verified_at=now() where id=$1`, [rows[0].user_id]);
  await pool.query(`update user_profiles set account_status=case when terms_accepted_at is null then 'pending_terms' when account_role='recruiter' then 'pending_approval' else 'active' end,updated_at=now() where id=$1`, [rows[0].user_id]);
  res.json({ ok: true });
});
app.post('/api/auth/resend-verification', async (req, res, next) => {
  try {
    const email = clean(req.body?.email, 254).toLowerCase();
    const { rows } = await pool.query(`select id,email_verified_at from app_users where email=$1`, [email]);
    if (rows[0] && !rows[0].email_verified_at) { const token = await createEmailToken(rows[0].id, 'verify_email'); await sendMail(email, 'Verify your HRs Portal email', `Verify your email: ${webUrl(`/?auth=verify&token=${encodeURIComponent(token)}`)}`); }
    res.json({ ok: true, message: 'If the address has an unverified account, a verification link will be sent.' });
  } catch (e) { next(e); }
});
app.post('/api/auth/forgot-password', async (req, res, next) => {
  try {
    const email = clean(req.body?.email, 254).toLowerCase();
    const { rows } = await pool.query('select id from app_users where email=$1', [email]);
    if (rows[0]) { const token = await createEmailToken(rows[0].id, 'reset_password'); await sendMail(email, 'Reset your HRs Portal password', `Reset your password: ${webUrl(`/?auth=reset&token=${encodeURIComponent(token)}`)}\nThis link expires in 24 hours.`); }
    res.json({ ok: true, message: "If an account matches that email address, we'll send instructions." });
  } catch (e) { next(e); }
});
app.post('/api/auth/reset-password', async (req, res, next) => {
  try {
    const token = clean(req.body?.token, 200), password = req.body?.password;
    if (typeof password !== 'string' || password.length < 12 || password.length > 1024) return res.status(400).json({ error: 'Use between 12 and 1024 characters.' });
    const hash = await passwordHash(password);
    const { rows } = await pool.query(`delete from auth_tokens where token_hash=$1 and purpose='reset_password' and expires_at>now() returning user_id`, [digest(token)]);
    if (!rows[0]) return res.status(400).json({ error: 'This reset link is invalid or expired.' });
    await pool.query('update app_users set password_hash=$1 where id=$2', [hash, rows[0].user_id]);
    await pool.query('delete from auth_sessions where user_id=$1', [rows[0].user_id]); res.json({ ok: true });
  } catch (e) { next(e); }
});
app.post('/api/auth/accept-invite', async (req,res,next)=>{
  try {const token=clean(req.body?.token,200),password=req.body?.password;if(typeof password!=='string'||password.length<12||password.length>1024)return res.status(400).json({error:'Use between 12 and 1024 characters.'});const {rows}=await pool.query(`delete from auth_tokens where token_hash=$1 and purpose='invite' and expires_at>now() returning user_id`,[digest(token)]);if(!rows[0])return res.status(400).json({error:'This invitation is invalid or expired.'});const hash=await passwordHash(password);await pool.query(`update app_users set password_hash=$1,email_verified_at=coalesce(email_verified_at,now()) where id=$2`,[hash,rows[0].user_id]);await pool.query(`update user_profiles set account_status=case when account_role='recruiter' then 'pending_approval' else 'active' end where id=$1`,[rows[0].user_id]);res.json({ok:true});}catch(e){next(e)}
});
app.post('/api/auth/change-password', requireAuth, async (req, res, next) => {
  try {
    if (typeof req.body?.password !== 'string' || req.body.password.length < 12 || req.body.password.length > 1024) return res.status(400).json({ error: 'Use between 12 and 1024 characters.' });
    const hash = await passwordHash(req.body.password);
    await pool.query('update app_users set password_hash=$1 where id=$2', [hash, req.auth.user_id]);
    await pool.query('delete from auth_sessions where user_id=$1', [req.auth.user_id]); clearSessionCookie(res); res.json({ ok: true });
  } catch (e) { next(e); }
});

app.post('/api/auth/accept-terms', requireAuth, async (req, res) => {
  const { fullName, role, termsVersion, accepted } = req.body || {};
  if (accepted !== true || termsVersion !== '2026-10-01' || !clean(fullName,120) || !['candidate','recruiter'].includes(role)) return res.status(400).json({ error: 'Check the required details and accept the current terms.' });
  const status = !req.auth.email_verified_at ? 'pending_verification' : role === 'recruiter' ? 'pending_approval' : 'active';
  const { rows } = await pool.query(`update user_profiles set full_name=$1,account_role=$2,account_status=$3,terms_version=$4,terms_accepted_at=now(),updated_at=now() where id=$5 and account_status='pending_terms' returning *`, [clean(fullName,120), role, status, termsVersion, req.auth.user_id]);
  if (!rows[0]) return res.status(409).json({ error: 'Registration terms were already accepted or this account is unavailable.' });
  res.json({ data: rows[0] });
});

app.get('/api/profile', requireAuth, async (req,res) => {
  const profile = (await pool.query('select id,full_name,account_role,account_status,onboarding_completed_at,email_verified_at from user_profiles join app_users using(id) where id=$1',[req.auth.user_id])).rows[0];
  if (!profile) return res.status(404).json({ error: 'Profile not found.' });
  const candidate = (await pool.query('select id,full_name,target_role,location,experience_level,work_style,skills,bio,visibility,resume_name,resume_key from candidate_profiles where id=$1',[req.auth.user_id])).rows[0] || null;
  res.json({ profile, candidate });
});
app.get('/api/company-membership', requireAuth, async (req,res) => {
  const { rows } = await pool.query(`select m.company_id,m.role,m.status,c.verification_status from company_memberships m join companies c on c.id=m.company_id where m.user_id=$1 and m.status='active' order by m.created_at desc limit 1`, [req.auth.user_id]);
  res.json({ membership: rows[0] || null });
});
app.patch('/api/profile', requireAuth, async (req,res) => {
  const name = clean(req.body?.full_name,120); if (!name) return res.status(400).json({ error:'Enter a valid name.' });
  const { rows } = await pool.query('update user_profiles set full_name=$1,updated_at=now() where id=$2 returning *',[name,req.auth.user_id]); res.json({ profile:rows[0] });
});
app.post('/api/candidate-profile', requireAuth, requireVerified, async (req,res) => {
  if (req.auth.account_role !== 'candidate' || req.auth.account_status !== 'active') return res.status(403).json({ error:'Only active candidate accounts can save a candidate profile.' });
  await ensureRegistrationResumeSchema();
  const x=req.body||{}; const staged=(await pool.query('select resume_key,resume_name from registration_resume_staging where user_id=$1 and expires_at>now()',[req.auth.user_id])).rows[0]; const fields=[clean(x.full_name,120),clean(x.target_role,120),clean(x.location,120),clean(x.experience_level,80),clean(x.work_style,60),Array.isArray(x.skills)?x.skills.map(v=>clean(v,40)).filter(Boolean).slice(0,30):[],clean(x.bio,1000),clean(x.resume_key,300)||staged?.resume_key||'',clean(x.resume_name,200)||staged?.resume_name||''];
  if(fields.slice(0,4).some(v=>!v)||!fields[7]||!fields[8]||!fields[7].startsWith(`${req.auth.user_id}/`))return res.status(400).json({error:'Complete your profile and upload your resume first.'});
  const { rows }=await pool.query(`insert into candidate_profiles(id,full_name,target_role,location,experience_level,work_style,skills,bio,resume_key,resume_name) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) on conflict(id) do update set full_name=excluded.full_name,target_role=excluded.target_role,location=excluded.location,experience_level=excluded.experience_level,work_style=excluded.work_style,skills=excluded.skills,bio=excluded.bio,resume_key=excluded.resume_key,resume_name=excluded.resume_name,updated_at=now() returning *`,[req.auth.user_id,...fields]);
  if(staged?.resume_key&&staged.resume_key!==fields[7]&&hasResumeStorage())await deleteResume(staged.resume_key).catch(()=>{});
  await pool.query('delete from registration_resume_staging where user_id=$1',[req.auth.user_id]);
  await pool.query('update user_profiles set full_name=$1,onboarding_completed_at=coalesce(onboarding_completed_at,now()),updated_at=now() where id=$2',[fields[0],req.auth.user_id]); res.json({ candidate:rows[0] });
});
app.get('/api/candidate-profile/staged-resume', requireAuth, requireVerified, async (req,res)=>{
  if(req.auth.account_role!=='candidate')return res.status(403).json({error:'Candidate access is required.'});
  await ensureRegistrationResumeSchema();
  const {rows}=await pool.query('select resume_key as key,resume_name as name from registration_resume_staging where user_id=$1 and expires_at>now()',[req.auth.user_id]);
  res.json({resume:rows[0]||null});
});
const resumeUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024, files: 1 }, fileFilter: (_req,file,cb) => /\.(pdf|doc|docx)$/i.test(file.originalname) ? cb(null,true) : cb(Object.assign(new Error('Choose a PDF, DOC or DOCX resume.'),{status:400})) });
app.post('/api/resumes', requireAuth, requireVerified, resumeUpload.single('resume'), async (req,res,next) => {
  try {
    if(!hasResumeStorage())return res.status(503).json({error:'Private resume storage is not configured.'});
    if(req.auth.account_role!=='candidate'||req.auth.account_status!=='active')return res.status(403).json({error:'Candidate access is required.'});
    if(!req.file)return res.status(400).json({error:'Choose a resume file.'});
    const ext=req.file.originalname.toLowerCase().match(/\.(pdf|doc|docx)$/)?.[1];
    const mimeByExt={pdf:'application/pdf',doc:'application/msword',docx:'application/vnd.openxmlformats-officedocument.wordprocessingml.document'};
    if(req.file.mimetype&&req.file.mimetype!=='application/octet-stream'&&req.file.mimetype!==mimeByExt[ext])return res.status(400).json({error:'The resume file type does not match its extension.'});
    const key=`${req.auth.user_id}/${Date.now()}-${crypto.randomBytes(5).toString('hex')}.${ext}`;
    await saveResume(key,req.file.buffer,req.file.mimetype);
    res.status(201).json({ key, name: req.file.originalname });
  } catch(e){next(e);}
});
app.delete('/api/resumes', requireAuth, async (req,res,next)=>{try{const key=clean(req.query.key,300);if(!key.startsWith(`${req.auth.user_id}/`))return res.status(403).json({error:'Resume access is not allowed.'});if(hasResumeStorage())await deleteResume(key);await pool.query('delete from candidate_profiles where id=$1 and resume_key=$2',[req.auth.user_id,key]);res.json({ok:true});}catch(e){next(e)}});
app.get('/api/resumes', requireAuth, async (req,res,next) => {
  try {
    if(!hasResumeStorage())return res.status(503).json({error:'Private resume storage is not configured.'});
    const key=clean(req.query.key,300); const own=key.startsWith(`${req.auth.user_id}/`);
    if(!own){const {rows}=await pool.query(`select 1 from job_applications a join candidate_profiles c on c.id=a.candidate_id where a.id=$1 and a.resume_shared=true and c.resume_key=$2 and exists(select 1 from job_listings j join company_memberships m on m.company_id=j.company_id join companies co on co.id=j.company_id where j.id=a.job_id and m.user_id=$3 and m.status='active' and co.verification_status='verified' and exists(select 1 from user_profiles p where p.id=m.user_id and p.account_role='recruiter' and p.account_status='active'))`,[req.query.application,key,req.auth.user_id]);const {rows:admins}=await pool.query(`select 1 from platform_admins where user_id=$1 and role='super_admin' and status='active'`,[req.auth.user_id]);if(!rows.length&&!admins.length)return res.status(403).json({error:'Resume access is not allowed.'});}
    if(req.query.download==='1'){
      if(!s3){const buffer=await readResume(key);res.setHeader('Content-Type',key.endsWith('.pdf')?'application/pdf':'application/octet-stream');res.setHeader('Content-Disposition',`attachment; filename="${path.basename(key)}"`);return res.send(buffer);}
      const url=await getSignedUrl(s3,new GetObjectCommand({Bucket:process.env.S3_BUCKET,Key:key}),{expiresIn:60});return res.redirect(302,url);
    }
    const localApiOrigin=`http://localhost:${Number(process.env.PORT||3000)}`;
    const url=s3?await getSignedUrl(s3,new GetObjectCommand({Bucket:process.env.S3_BUCKET,Key:key}),{expiresIn:60}):`${localApiOrigin}/api/resumes?key=${encodeURIComponent(key)}${req.query.application?`&application=${encodeURIComponent(req.query.application)}`:''}&download=1`; res.json({url,expiresInSeconds:60});
  }catch(e){next(e);}
});
const careerRateLimit = rateLimit({ windowMs: 60 * 60 * 1000, limit: 6, keyGenerator: (req) => req.auth.user_id, standardHeaders: 'draft-7', legacyHeaders: false });
const applicationRateLimit = rateLimit({ windowMs: 60 * 60 * 1000, limit: 20, keyGenerator: (req) => req.auth.user_id, standardHeaders: 'draft-7', legacyHeaders: false });
const requireCandidate = (req, res, next) => req.auth?.email_verified_at && req.auth?.account_role === 'candidate' && req.auth?.account_status === 'active' ? next() : res.status(403).json({ error: 'An active, verified candidate account is required.' });
app.get('/api/career/jobs', requireAuth, requireCandidate, async (req,res,next) => {
  try {
    const expected = Number(req.query.expectedCtcLpa);
    const profile = (await pool.query('select expected_ctc_lpa,target_role,location,work_style,skills from candidate_profiles where id=$1', [req.auth.user_id])).rows[0] || {};
    const expectedLpa = Number.isFinite(expected) && expected > 0 && expected <= 10000 ? expected : Number(profile?.expected_ctc_lpa) || null;
    const { rows } = await pool.query(`select j.id,j.title,j.description,j.location,j.work_style,j.employment_type,j.salary_min,j.salary_max,j.published_at,c.name as company_name
      from job_listings j join companies c on c.id=j.company_id
      where j.status='published' and c.verification_status='verified'
      and ($1::numeric is null or j.salary_max is null or j.salary_max >= $1)
      order by j.published_at desc nulls last limit 100`, [expectedLpa]);
    res.json({ jobs: rankCareerJobs(profile, rows), expectedCtcLpa: expectedLpa });
  } catch (e) { next(e); }
});
app.get('/api/career/status', requireAuth, requireCandidate, async (req,res,next) => {
  try {
    const { rows } = await pool.query('select resume_name,expected_ctc_lpa from candidate_profiles where id=$1', [req.auth.user_id]);
    res.json({ aiEnabled: Boolean(process.env.AI_API_KEY && process.env.AI_MODEL), resumeReady: Boolean(rows[0]?.resume_name), resumeName: rows[0]?.resume_name || null, expectedCtcLpa: rows[0]?.expected_ctc_lpa || null });
  } catch (e) { next(e); }
});
app.post('/api/career/preferences', requireAuth, requireCandidate, async (req,res,next) => {
  try {
    const value = req.body?.expectedCtcLpa === null || req.body?.expectedCtcLpa === '' ? null : Number(req.body?.expectedCtcLpa);
    if (value !== null && (!Number.isFinite(value) || value < 0 || value > 10000)) return res.status(400).json({ error: 'Enter an annual CTC between ₹0 and ₹10,000 LPA.' });
    const { rows } = await pool.query('update candidate_profiles set expected_ctc_lpa=$1,updated_at=now() where id=$2 returning expected_ctc_lpa', [value, req.auth.user_id]);
    if (!rows[0]) return res.status(404).json({ error: 'Finish your candidate profile first.' });
    res.json({ expectedCtcLpa: rows[0].expected_ctc_lpa });
  } catch (e) { next(e); }
});
app.post('/api/career/copilot', requireAuth, requireCandidate, careerRateLimit, async (req,res,next) => {
  try {
    if (req.body?.consent !== true) return res.status(400).json({ error: 'Review and accept the AI processing notice before continuing.' });
    if (!hasResumeStorage()) return res.status(503).json({ error: 'Private resume storage is not configured.' });
    const action = ['tailor','analyze','chat'].includes(req.body?.action) ? req.body.action : '';
    if (!action) return res.status(400).json({ error: 'Choose resume analysis or job tailoring.' });
    const requestedJobId = clean(req.body?.jobId,80);
    if ((action === 'tailor' || requestedJobId) && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(requestedJobId)) return res.status(400).json({ error: 'Choose a valid published job.' });
    const profile = (await pool.query('select target_role,location,experience_level,skills,expected_ctc_lpa,resume_key,resume_name from candidate_profiles where id=$1', [req.auth.user_id])).rows[0];
    if (!profile?.resume_key?.startsWith(`${req.auth.user_id}/`)) return res.status(404).json({ error: 'Upload and save a resume before using Career Copilot.' });
    let job = null;
    if (action === 'tailor' || requestedJobId) {
      if (action === 'tailor' && !req.body?.jobId) return res.status(400).json({ error: 'Choose a published job to tailor your resume.' });
      job = (await pool.query(`select j.id,j.title,j.description,j.location,j.work_style,j.employment_type,j.salary_min,j.salary_max,c.name as company_name
        from job_listings j join companies c on c.id=j.company_id where j.id=$1 and j.status='published' and c.verification_status='verified'`, [requestedJobId])).rows[0];
      if (!job) return res.status(404).json({ error: 'This job is no longer open.' });
    }
    const buffer = await readResume(profile.resume_key);
    const extension = profile.resume_name.toLowerCase().match(/\.(pdf|docx?)$/)?.[1];
    const resumeText = await extractResumeText(buffer, extension);
    const ctc = req.body?.expectedCtcLpa === undefined ? Number(profile.expected_ctc_lpa) || null : Number(req.body.expectedCtcLpa) || null;
    if (ctc !== null && (!Number.isFinite(ctc) || ctc < 0 || ctc > 10000)) return res.status(400).json({ error: 'Enter a valid expected annual CTC in LPA.' });
    if (action === 'tailor' && ctc && job.salary_max && ctc > Number(job.salary_max)) return res.status(409).json({ error: 'This job is below your expected CTC. Update your preference only if the listed pay is acceptable to you.' });
    let jobs = [];
    if (action === 'chat') {
      const { rows } = await pool.query(`select j.id,j.title,j.description,j.location,j.work_style,j.employment_type,j.salary_min,j.salary_max,j.published_at,c.name as company_name
        from job_listings j join companies c on c.id=j.company_id where j.status='published' and c.verification_status='verified'
        and ($1::numeric is null or j.salary_max is null or j.salary_max >= $1) order by j.published_at desc nulls last limit 50`, [ctc]);
      jobs = rankCareerJobs(profile, rows).slice(0, 5);
    }
    const history = Array.isArray(req.body?.history) ? req.body.history.filter((item) => ['user','assistant'].includes(item?.role) && typeof item?.content === 'string').map((item) => ({ role:item.role, content:clean(item.content,1000) })).slice(-8) : [];
    const result = await requestCareerDraft({ action, resumeText, profile, job, jobs, expectedCtcLpa: ctc, message: clean(req.body?.message,1500), history });
    res.json({ result, jobs: jobs.map((item) => ({ id:item.id,title:item.title,company_name:item.company_name,location:item.location,work_style:item.work_style,salary_min:item.salary_min,salary_max:item.salary_max,match_score:item.match_score,matched_skills:item.matched_skills })), job: job ? { id: job.id, title: job.title, companyName: job.company_name } : null, resumeName: profile.resume_name });
  } catch (e) { if (e.status) return res.status(e.status).json({ error: e.message }); next(e); }
});
app.post('/api/career/applications', requireAuth, requireCandidate, applicationRateLimit, async (req,res,next) => {
  try {
    if (req.body?.confirmed !== true) return res.status(400).json({ error: 'Confirm this specific application before submitting.' });
    const jobId = clean(req.body?.jobId, 80), resumeSnapshot = clean(req.body?.resumeSnapshot, 16000);
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(jobId)) return res.status(400).json({ error: 'Choose a valid published job.' });
    if (resumeSnapshot.length < 100) return res.status(400).json({ error: 'Review and save a complete tailored resume draft before applying.' });
    const { rows: jobsFound } = await pool.query(`select j.id,j.salary_max from job_listings j join companies c on c.id=j.company_id where j.id=$1 and j.status='published' and c.verification_status='verified'`, [jobId]);
    if (!jobsFound[0]) return res.status(404).json({ error: 'This job is no longer open.' });
    const candidate = (await pool.query('select resume_key,expected_ctc_lpa from candidate_profiles where id=$1', [req.auth.user_id])).rows[0];
    if (!candidate?.resume_key) return res.status(400).json({ error: 'Save your candidate profile and resume before applying.' });
    if (candidate.expected_ctc_lpa && jobsFound[0].salary_max && Number(candidate.expected_ctc_lpa) > Number(jobsFound[0].salary_max)) return res.status(409).json({ error: 'This job is below your saved expected CTC. Update your preference if it is still acceptable to you.' });
    const { rows } = await pool.query(`insert into job_applications(job_id,candidate_id,status,resume_shared,resume_snapshot)
      values($1,$2,'submitted',$3,$4) returning id,job_id,status,resume_shared,created_at`, [jobId, req.auth.user_id, req.body.shareResume === true, resumeSnapshot]);
    res.status(201).json({ application: rows[0] });
  } catch (e) { if (e.code === '23505') return res.status(409).json({ error: 'You already applied to this job.' }); next(e); }
});
app.get('/api/career/applications', requireAuth, requireCandidate, async (req,res,next) => {
  try {
    const { rows } = await pool.query(`select a.id,a.job_id,a.status,a.resume_shared,a.created_at,j.title,j.location,j.work_style,c.name as company_name
      from job_applications a join job_listings j on j.id=a.job_id join companies c on c.id=j.company_id
      where a.candidate_id=$1 order by a.created_at desc limit 100`, [req.auth.user_id]);
    res.json({ applications: rows });
  } catch (e) { next(e); }
});
app.get('/api/career/applications/:id/resume', requireAuth, async (req,res,next) => {
  try {
    const { rows } = await pool.query(`select a.resume_snapshot,a.resume_shared,a.job_id,a.candidate_id,j.company_id,c.resume_key,c.resume_name
      from job_applications a join job_listings j on j.id=a.job_id join candidate_profiles c on c.id=a.candidate_id
      where a.id=$1`, [clean(req.params.id,80)]);
    if (!rows[0] || !rows[0].resume_shared) return res.status(404).json({ error: 'No resume was shared for this application.' });
    if (rows[0].candidate_id === req.auth.user_id) return res.json({ resumeText: rows[0].resume_snapshot || null, resumeName: rows[0].resume_name });
    if (req.auth.account_role !== 'recruiter' || req.auth.account_status !== 'active') return res.status(403).json({ error: 'This application belongs to another hiring team.' });
    const { rows: access } = await pool.query(`select 1 from company_memberships m join companies co on co.id=m.company_id join user_profiles p on p.id=m.user_id
      where m.company_id=$1 and m.user_id=$2 and m.status='active' and co.verification_status='verified' and p.account_role='recruiter' and p.account_status='active'`, [rows[0].company_id, req.auth.user_id]);
    if (!access.length) return res.status(403).json({ error: 'This application belongs to another hiring team.' });
    res.json({ resumeText: rows[0].resume_snapshot || null, resumeName: rows[0].resume_name });
  } catch (e) { next(e); }
});
app.delete('/api/account', requireAuth, async (req,res,next) => {
  const client=await pool.connect(); try { await ensureRegistrationResumeSchema();const {rows:owned}=await client.query('select 1 from companies where created_by=$1 limit 1',[req.auth.user_id]);if(owned.length)return res.status(409).json({error:'Transfer or remove company ownership before deleting this account.'});
    const {rows}=await client.query('select resume_key from candidate_profiles where id=$1',[req.auth.user_id]);const staged=(await client.query('select resume_key from registration_resume_staging where user_id=$1',[req.auth.user_id])).rows[0];if(rows[0]?.resume_key&&hasResumeStorage())await deleteResume(rows[0].resume_key);if(staged?.resume_key&&staged.resume_key!==rows[0]?.resume_key&&hasResumeStorage())await deleteResume(staged.resume_key);await client.query('delete from app_users where id=$1',[req.auth.user_id]);clearSessionCookie(res);res.json({ok:true});
  }catch(e){next(e)}finally{client.release()}
});

// TOTP enrollment and verification are kept in the Node service and bind to this account.
app.post('/api/admin/mfa/enroll', requireAuth, async (req,res,next) => {
  try { const {rows}=await pool.query(`select role from platform_admins where user_id=$1 and role in ('admin','super_admin') and status='active'`,[req.auth.user_id]);if(!rows.length)return res.status(403).json({error:'Active platform admin access is required.'});const secret=authenticator.generateSecret();await pool.query('insert into user_mfa(user_id,secret,verified_at) values($1,$2,null) on conflict(user_id) do update set secret=excluded.secret,verified_at=null',[req.auth.user_id,encryptSecret(secret)]);const uri=authenticator.keyuri(req.auth.email,`HRs Portal ${rows[0].role==='super_admin'?'Super Admin':'Admin'}`,secret);res.json({secret,uri,qrCode:await QRCode.toDataURL(uri)}); }catch(e){next(e)}
});
app.get('/api/admin/mfa/status', requireAuth, async (req,res)=>{const {rows}=await pool.query('select verified_at from user_mfa where user_id=$1',[req.auth.user_id]);res.json({enrolled:Boolean(rows[0]?.verified_at)});});
app.post('/api/admin/mfa/verify', requireAuth, async (req,res,next) => {
  try { const code=clean(req.body?.code,6);const {rows}=await pool.query('select secret from user_mfa where user_id=$1',[req.auth.user_id]);if(!rows[0]||!authenticator.check(code,decryptSecret(rows[0].secret)))return res.status(400).json({error:'Authenticator code is invalid.'});await pool.query('update user_mfa set verified_at=now() where user_id=$1',[req.auth.user_id]);await pool.query('update auth_sessions set mfa_verified=true where token_hash=$1',[digest(req.cookies[cookieName])]);res.json({ok:true}); }catch(e){next(e)}
});

// Provider login uses standard authorization-code + PKCE with provider secrets held only on Render.
const oauthProviders={google:{authorize:'https://accounts.google.com/o/oauth2/v2/auth',token:'https://oauth2.googleapis.com/token',userinfo:'https://openidconnect.googleapis.com/v1/userinfo',scope:'openid email profile',env:['GOOGLE_CLIENT_ID','GOOGLE_CLIENT_SECRET']},linkedin:{authorize:'https://www.linkedin.com/oauth/v2/authorization',token:'https://www.linkedin.com/oauth/v2/accessToken',userinfo:'https://api.linkedin.com/v2/userinfo',scope:'openid profile email',env:['LINKEDIN_CLIENT_ID','LINKEDIN_CLIENT_SECRET']}};
app.get('/api/oauth/:provider/start', async (req,res,next)=>{
  try {const provider=oauthProviders[req.params.provider];if(!provider)return res.status(404).json({error:'Provider not supported.'});const [clientId,secret]=provider.env.map(k=>process.env[k]);if(!clientId||!secret)return res.status(503).json({error:'This sign-in provider is not configured.'});const linkUserId=req.query.link==='1'?req.auth?.user_id:null;if(req.query.link==='1'&&!linkUserId)return res.status(401).json({error:'Sign in before connecting a provider.'});const portal=req.query.link==='1'?'candidate':clean(req.query.portal,24)||'candidate';if(!['candidate','recruiter','company'].includes(portal))return res.status(400).json({error:'This sign-in portal cannot use social sign-in.'});const state=opaqueToken(),verifier=opaqueToken(),challenge=b64url(crypto.createHash('sha256').update(verifier).digest());await pool.query(`insert into oauth_states(state_hash,verifier,provider,portal,link_user_id,expires_at) values($1,$2,$3,$4,$5,now()+interval '10 minutes')`,[digest(state),verifier,req.params.provider,portal,linkUserId]);const cb=webUrl(`/api/oauth/${req.params.provider}/callback`);const u=new URL(provider.authorize);for(const [k,v] of Object.entries({response_type:'code',client_id:clientId,redirect_uri:cb,scope:provider.scope,state,code_challenge:challenge,code_challenge_method:'S256'}))u.searchParams.set(k,v);res.redirect(u.toString());}catch(e){next(e)}
});
app.get('/api/oauth/:provider/callback', async (req,res,next)=>{
  try {const name=req.params.provider,p=oauthProviders[name];if(!p)return res.redirect(webUrl('/?auth=login&error=provider'));const [clientId,clientSecret]=p.env.map(k=>process.env[k]);const state=clean(req.query.state,300),code=clean(req.query.code,300);const {rows}=await pool.query(`delete from oauth_states where state_hash=$1 and provider=$2 and expires_at>now() returning verifier,link_user_id,portal`,[digest(state),name]);if(!rows[0]||!code)return res.redirect(webUrl('/?auth=login&error=oauth_state'));const tokenResponse=await fetch(p.token,{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({grant_type:'authorization_code',code,redirect_uri:webUrl(`/api/oauth/${name}/callback`),client_id:clientId,client_secret:clientSecret,code_verifier:rows[0].verifier})});if(!tokenResponse.ok)throw new Error('OAuth token exchange failed');const token=await tokenResponse.json();const userResponse=await fetch(p.userinfo,{headers:{authorization:`Bearer ${token.access_token}`}});if(!userResponse.ok)throw new Error('OAuth profile request failed');const identity=await userResponse.json(),email=clean(identity.email,254).toLowerCase(),subject=clean(identity.sub,300),fullName=clean(identity.name,120)||'New member';if(!emailOk(email)||identity.email_verified===false||!subject)throw new Error('Provider email is not verified');const client=await pool.connect();let userId;try{await client.query('begin');const linked=(await client.query('select user_id from oauth_accounts where provider=$1 and provider_subject=$2',[name,subject])).rows[0];if(linked){if(rows[0].link_user_id&&linked.user_id!==rows[0].link_user_id)throw new Error('This provider is already connected to another account.');userId=linked.user_id;}else if(rows[0].link_user_id){userId=rows[0].link_user_id;await client.query('insert into oauth_accounts(provider,provider_subject,user_id,provider_email) values($1,$2,$3,$4)',[name,subject,userId,email]);}else{const existing=(await client.query('select id from app_users where email=$1',[email])).rows[0];if(existing)throw new Error('This email already has an account. Sign in with that account first, then connect this provider in account settings.');if(rows[0].portal==='company')throw new Error('Company accounts must be invited to a verified company.');const user=(await client.query('insert into app_users(email,email_verified_at) values($1,now()) returning id',[email])).rows[0];userId=user.id;await client.query(`insert into user_profiles(id,full_name,account_role,account_status) values($1,$2,$3,'pending_terms')`,[userId,fullName,rows[0].portal]);await client.query('insert into oauth_accounts(provider,provider_subject,user_id,provider_email) values($1,$2,$3,$4)',[name,subject,userId,email]);}await client.query('update app_users set email_verified_at=coalesce(email_verified_at,now()),last_sign_in_at=now() where id=$1',[userId]);await client.query('commit');}catch(e){await client.query('rollback');throw e}finally{client.release()}if(!rows[0].link_user_id){const access=(await pool.query(`select p.account_role,p.account_status,a.role as platform_role,a.status as platform_status,m.role as membership_role,m.status as membership_status,c.verification_status as company_status from user_profiles p left join platform_admins a on a.user_id=p.id left join lateral (select m.company_id,m.role,m.status from company_memberships m join companies co on co.id=m.company_id where m.user_id=p.id order by (m.status='active' and co.verification_status='verified' and m.role='company_admin') desc,m.created_at desc limit 1) m on true left join companies c on c.id=m.company_id where p.id=$1`,[userId])).rows[0];if(!canAccessLoginPortal(rows[0].portal,access||{}))throw new Error('This account is not assigned to that sign-in portal.');}const opaque=opaqueToken();const account=(await pool.query(`select a.role,a.status,u.email_verified_at from app_users u left join platform_admins a on a.user_id=u.id where u.id=$1`,[userId])).rows[0];const isPlatformAdmin=['admin','super_admin'].includes(account?.role)&&account?.status==='active';await pool.query(`insert into auth_sessions(token_hash,user_id,mfa_verified,expires_at) values($1,$2,$3,now()+interval '${sessionDays} days')`,[digest(opaque),userId,!isPlatformAdmin]);setSessionCookie(res,opaque);res.redirect(webUrl('/?auth=callback'));}catch(e){console.error('OAuth callback failed:',e.message);res.redirect(webUrl('/?auth=login&error=oauth'));}
});

const adminTables={users:'user_profiles',companies:'companies',jobs:'job_listings',applications:'job_applications',memberships:'company_memberships',admins:'platform_admins',audit:'platform_audit_log'};
app.post('/api/admin', requireAuth, async (req,res,next)=>{
  if(req.body?.action==='mfa_status'){
    const {rows}=await pool.query(`select role,status from platform_admins where user_id=$1 and role in ('admin','super_admin')`,[req.auth.user_id]);return res.json({hasAdminAccess:rows[0]?.status==='active',role:rows[0]?.role||null,status:rows[0]?.status||null,aal:req.auth.mfa_verified?'aal2':'aal1'});
  }
  requireAdmin(req,res,()=>adminHandler(req,res,next));
});

// Browser data access is deliberately restricted to self-owned profile records.
app.post('/api/data', requireAuth, async (req,res,next)=>{
  try {
    const {table,operation='select',values,filters=[],single=false}=req.body||{};const allowed={
      user_profiles:{columns:['id','full_name','account_role','account_status','email_verified_at','onboarding_completed_at','created_at','updated_at'],mutable:['full_name','onboarding_completed_at']},
      candidate_profiles:{columns:['id','full_name','target_role','location','experience_level','work_style','skills','bio','expected_ctc_lpa','resume_name','resume_path','visibility','updated_at'],mutable:['full_name','target_role','location','experience_level','work_style','skills','bio','resume_path','resume_name','visibility','updated_at']},
      company_memberships:{columns:['company_id','user_id','role','status','created_at','companies'],mutable:[]}
    };
    const spec=allowed[table];if(!spec||!['select','insert','update'].includes(operation))return res.status(400).json({error:'Data operation is not available.'});
    const clauses=[],params=[];for(const [key,value] of filters){if(!['id','user_id','status','company_id'].includes(key))return res.status(400).json({error:'Filter is not allowed.'});params.push(value);clauses.push(`${key}=$${params.length}`)}
    if(table==='candidate_profiles'||table==='user_profiles'){if(clauses.some(c=>!c.startsWith('id=')))return res.status(400).json({error:'Only your own profile is available.'});if(clauses.length){clauses.push(`id=$${params.push(req.auth.user_id)}`)}else {clauses.push(`id=$1`);params.push(req.auth.user_id)}}
    if(table==='company_memberships'){if(clauses.some(c=>!c.startsWith('user_id=')&&!c.startsWith('status=')))return res.status(400).json({error:'Membership filter is not allowed.'});clauses.push(`user_id=$${params.push(req.auth.user_id)}`)}
    let result;
    if(operation==='select'){
      const requested=String(req.body.columns||'*').split(',').map(v=>v.trim().split('!')[0]);const columns=requested.includes('*')?spec.columns:requested.filter(v=>spec.columns.includes(v));if(!columns.length)return res.status(400).json({error:'No permitted columns selected.'});
      let sql;
      if(table==='user_profiles'){const select=columns.map(c=>c==='email_verified_at'?'u.email_verified_at as email_verified_at':`p.${c}`).join(',');sql=`select ${select} from user_profiles p join app_users u on u.id=p.id where ${clauses.join(' and ')}`;}
      else if(table==='candidate_profiles'){const select=columns.map(c=>c==='resume_path'?'resume_key as resume_path':c).join(',');sql=`select ${select} from candidate_profiles where ${clauses.join(' and ')}`;}
      else {const include=String(req.body.columns||'').includes('companies!inner')||String(req.body.columns||'').includes('companies(');sql=include?`select m.company_id,m.user_id,m.role,m.status,m.created_at,json_build_object('verification_status',c.verification_status) as companies from company_memberships m join companies c on c.id=m.company_id where ${clauses.map(c=>c.replaceAll('user_id','m.user_id').replaceAll('status','m.status').replaceAll('company_id','m.company_id')).join(' and ')}`:`select ${columns.filter(c=>c!=='companies').map(c=>`m.${c}`).join(',')} from company_memberships m where ${clauses.join(' and ')}`;}
      result=await pool.query(sql,params);result=result.rows;
    }else if(operation==='insert'){
      if(table!=='candidate_profiles'||req.auth.account_role!=='candidate'||req.auth.account_status!=='active')return res.status(403).json({error:'Candidate profile access is required.'});
      const map={full_name:'full_name',target_role:'target_role',location:'location',experience_level:'experience_level',work_style:'work_style',skills:'skills',bio:'bio',resume_path:'resume_key',resume_name:'resume_name'};const keys=Object.keys(map).filter(k=>values?.[k]!==undefined);if(!keys.length)return res.status(400).json({error:'Profile details are required.'});const vals=keys.map(k=>values[k]);const {rows}=await pool.query(`insert into candidate_profiles(id,${keys.map(k=>map[k]).join(',')}) values($1,${vals.map((_,i)=>`$${i+2}`).join(',')}) returning *,resume_key as resume_path`,[req.auth.user_id,...vals]);result=rows;
    }else{
      if(!spec.mutable.length)return res.status(403).json({error:'This record cannot be updated.'});const keys=Object.keys(values||{}).filter(k=>spec.mutable.includes(k)&&k!=='updated_at');if(!keys.length)return res.status(400).json({error:'Choose a permitted field to update.'});const cols=keys.map(k=>k==='resume_path'?'resume_key':k);const set=cols.map((k,i)=>`${k}=$${i+1}`).join(', ');const vals=keys.map(k=>values[k]);
      if(table==='candidate_profiles'&&req.auth.account_role!=='candidate')return res.status(403).json({error:'Candidate profile access is required.'});
      const {rows}=await pool.query(`update ${table} set ${set},updated_at=now() where id=$${keys.length+1} returning *`,[...vals,req.auth.user_id]);result=rows;
    }
    if(single)result=result[0]||null;res.json({data:result});
  }catch(e){next(e)}
});
async function audit(actor,action,type,id,details={}){await pool.query('insert into platform_audit_log(actor_id,action,entity_type,entity_id,details) values($1,$2,$3,$4,$5)',[actor,action,type,id,JSON.stringify(details)]);}
async function adminHandler(req,res,next){try{
  const body=req.body||{},action=clean(body.action,60);
  const superAdminActions=new Set(['list_admins','list_audit','invite_admin','update_admin']);
  if(req.platformAdminRole!=='super_admin'&&superAdminActions.has(action))return res.status(403).json({error:'This action requires Super Admin access.'});
  if(action==='me')return res.json({id:req.auth.user_id,email:req.auth.email,role:req.platformAdminRole});
  if(action==='overview'){const counts={};for(const [key,table] of Object.entries(adminTables).filter(([k])=>k!=='audit'))counts[key]=Number((await pool.query(`select count(*)::int as count from ${table}`)).rows[0].count);const recent=(await pool.query('select * from platform_audit_log order by created_at desc limit 8')).rows;return res.json({counts,recent});}
  if(action==='list_admins'){const rows=(await pool.query(`select a.*,u.email from platform_admins a join app_users u on u.id=a.user_id order by a.created_at desc`)).rows;return res.json({rows});}
  if(action==='list_audit'){const page=Math.max(1,Number(body.page)||1),size=Math.max(10,Math.min(100,Number(body.pageSize)||25));const [rows,count]=await Promise.all([pool.query('select * from platform_audit_log order by created_at desc limit $1 offset $2',[size,(page-1)*size]),pool.query('select count(*)::int as count from platform_audit_log')]);return res.json({rows:rows.rows,count:count.rows[0].count,page,pageSize:size});}
  if(action==='list_users'){const page=Math.max(1,Number(body.page)||1),size=Math.max(10,Math.min(100,Number(body.pageSize)||25)),term=`%${clean(body.search,120)}%`;const [rows,count]=await Promise.all([pool.query(`select u.id,u.email,u.email_verified_at as email_confirmed_at,u.created_at,u.last_sign_in_at,p as profile,c as candidate from app_users u join user_profiles p on p.id=u.id left join candidate_profiles c on c.id=u.id where u.email ilike $1 or p.full_name ilike $1 order by u.created_at desc limit $2 offset $3`,[term,size,(page-1)*size]),pool.query(`select count(*)::int as count from user_profiles p join app_users u on u.id=p.id where u.email ilike $1 or p.full_name ilike $1`,[term])]);return res.json({rows:rows.rows,count:count.rows[0].count,page,pageSize:size});}
  if(action==='list_jobs'){const page=Math.max(1,Number(body.page)||1),size=Math.max(10,Math.min(100,Number(body.pageSize)||25)),term=`%${clean(body.search,100)}%`;const [rows,count]=await Promise.all([pool.query(`select j.*,json_build_object('name',c.name) as companies from job_listings j join companies c on c.id=j.company_id where j.title ilike $1 order by j.created_at desc limit $2 offset $3`,[term,size,(page-1)*size]),pool.query('select count(*)::int as count from job_listings j where j.title ilike $1',[term])]);return res.json({rows:rows.rows,count:count.rows[0].count,page,pageSize:size});}
  if(action==='list_applications'){const page=Math.max(1,Number(body.page)||1),size=Math.max(10,Math.min(100,Number(body.pageSize)||25));const [rows,count]=await Promise.all([pool.query(`select a.*,json_build_object('title',j.title,'company_id',j.company_id,'companies',json_build_object('name',co.name)) as job_listings,json_build_object('id',c.id,'full_name',c.full_name,'target_role',c.target_role,'location',c.location) as candidate_profiles from job_applications a join job_listings j on j.id=a.job_id join companies co on co.id=j.company_id join candidate_profiles c on c.id=a.candidate_id order by a.created_at desc limit $1 offset $2`,[size,(page-1)*size]),pool.query('select count(*)::int as count from job_applications')]);return res.json({rows:rows.rows,count:count.rows[0].count,page,pageSize:size});}
  if(action==='list_memberships'){const page=Math.max(1,Number(body.page)||1),size=Math.max(10,Math.min(100,Number(body.pageSize)||25));const [rows,count]=await Promise.all([pool.query(`select m.*,json_build_object('name',c.name) as companies,p as profile,u.email from company_memberships m join companies c on c.id=m.company_id join user_profiles p on p.id=m.user_id join app_users u on u.id=m.user_id order by m.created_at desc limit $1 offset $2`,[size,(page-1)*size]),pool.query('select count(*)::int as count from company_memberships')]);return res.json({rows:rows.rows,count:count.rows[0].count,page,pageSize:size});}
  const listing={list_companies:['companies',`id,name,website,verification_status,created_at,updated_at,created_by`,'name'],list_jobs:['job_listings',`id,company_id,created_by,title,description,location,work_style,employment_type,salary_min,salary_max,status,published_at,created_at,updated_at`,'title'],list_applications:['job_applications','*','status'],list_memberships:['company_memberships','*','role']};
  if(listing[action]){const [table,cols,searchCol]=listing[action],page=Math.max(1,Number(body.page)||1),size=Math.max(10,Math.min(100,Number(body.pageSize)||25)),search=clean(body.search,100);const where=search?`where ${searchCol} ilike $1`:'';const values=search?[`%${search}%`,size,(page-1)*size]:[size,(page-1)*size];const query=search?`select ${cols} from ${table} ${where} order by created_at desc limit $2 offset $3`:`select ${cols} from ${table} order by created_at desc limit $1 offset $2`;const rows=await pool.query(query,values);const count=await pool.query(`select count(*)::int as count from ${table} ${where}`,search?[`%${search}%`]:[]);return res.json({rows:rows.rows,count:count.rows[0].count,page,pageSize:size});}
  if(action==='application_resume'){const {rows}=await pool.query(`select c.resume_key,c.resume_name from job_applications a join candidate_profiles c on c.id=a.candidate_id where a.id=$1 and a.resume_shared=true`,[body.id]);if(!rows[0]||!hasResumeStorage())return res.status(404).json({error:'No shared resume is available.'});const url=s3?await getSignedUrl(s3,new GetObjectCommand({Bucket:process.env.S3_BUCKET,Key:rows[0].resume_key}),{expiresIn:60}):`http://localhost:${Number(process.env.PORT||3000)}/api/resumes?key=${encodeURIComponent(rows[0].resume_key)}&application=${encodeURIComponent(body.id)}&download=1`;await audit(req.auth.user_id,'view_shared_resume','application',body.id,{resume_name:rows[0].resume_name});return res.json({url,fileName:rows[0].resume_name,expiresInSeconds:60});}
  if(action==='invite_user'||action==='invite_admin'){
    const email=clean(body.email,254).toLowerCase();if(!emailOk(email))return res.status(400).json({error:'Enter a valid email address.'});
    const role=action==='invite_admin'?'recruiter':body.role;if(!['candidate','recruiter'].includes(role))return res.status(400).json({error:'Choose Candidate or Recruiter.'});
    let fullName=clean(body.full_name,120)||'Invited member';let user=(await pool.query('select id from app_users where email=$1',[email])).rows[0];
    if(!user){user=(await pool.query('insert into app_users(email) values($1) returning id',[email])).rows[0];await pool.query(`insert into user_profiles(id,full_name,account_role,account_status) values($1,$2,$3,'pending_terms')`,[user.id,fullName,role]);}
    const token=await createEmailToken(user.id,'invite');await sendMail(email,'You are invited to HRs Portal',`Complete your HRs Portal account: ${webUrl(`/?auth=invite&token=${encodeURIComponent(token)}`)}`);
    if(action==='invite_admin'){await pool.query(`insert into platform_admins(user_id,role,status,invited_by) values($1,'admin','invited',$2) on conflict(user_id) do update set status='invited',invited_by=excluded.invited_by`,[user.id,req.auth.user_id]);await audit(req.auth.user_id,'invite_admin','platform_admin',user.id,{email});return res.json({row:{user_id:user.id,email,role:'admin',status:'invited'}});}
    await audit(req.auth.user_id,'invite_user','user',user.id,{email,role});return res.json({invited:true,id:user.id,email});
  }
  if(action==='update_admin'){
    const id=clean(body.id,80);if(!id)return res.status(400).json({error:'Choose an admin.'});
    const {rows:currentRows}=await pool.query('select role,status from platform_admins where user_id=$1',[id]);
    if(!currentRows[0])return res.status(404).json({error:'Admin account not found.'});
    const role=body.role||currentRows[0].role,status=body.status||currentRows[0].status;
    if(!['admin','super_admin'].includes(role)||!['invited','active','suspended'].includes(status))return res.status(400).json({error:'Choose a valid admin role and status.'});
    if(id===req.auth.user_id&&(role!=='super_admin'||status!=='active'))return res.status(400).json({error:'You cannot remove or suspend your own Super Admin access.'});
    if(currentRows[0].role==='super_admin'&&currentRows[0].status==='active'&&(role!=='super_admin'||status!=='active')){const count=(await pool.query(`select count(*)::int as n from platform_admins where role='super_admin' and status='active'`)).rows[0].n;if(count<=1)return res.status(400).json({error:'Keep at least one active Super Admin on the platform.'});}
    const {rows}=await pool.query('update platform_admins set role=$1,status=$2,updated_at=now() where user_id=$3 returning *',[role,status,id]);if(!rows[0])return res.status(404).json({error:'Admin account not found.'});await audit(req.auth.user_id,'update_admin','platform_admin',id,{role,status});return res.json({row:rows[0]});
  }
  const updateMap={update_user:{table:'user_profiles',id:'id',allowed:['full_name','account_role','account_status']},update_company:{table:'companies',id:'id',allowed:['name','website','verification_status']},update_job:{table:'job_listings',id:'id',allowed:['title','description','location','work_style','employment_type','salary_min','salary_max','status']},update_application:{table:'job_applications',id:'id',allowed:['status','recruiter_note']},update_admin:{table:'platform_admins',id:'user_id',allowed:['role','status']}};
  const m=updateMap[action];if(m){const patch=Object.fromEntries(m.allowed.filter(k=>body[k]!==undefined).map(k=>[k,body[k]]));if(!Object.keys(patch).length)return res.status(400).json({error:'Choose a field to update.'});if(m.table==='user_profiles'&&patch.account_role&&!['candidate','recruiter'].includes(patch.account_role))return res.status(400).json({error:'Public roles are candidate and recruiter.'});const fields=Object.keys(patch),set=fields.map((k,i)=>`${k}=$${i+1}`).join(', ');const {rows}=await pool.query(`update ${m.table} set ${set},updated_at=now() where ${m.id}=$${fields.length+1} returning *`,[...fields.map(k=>patch[k]),body.id]);if(!rows[0])return res.status(404).json({error:'Record not found.'});await audit(req.auth.user_id,action,m.table,body.id,{fields});return res.json({row:rows[0]});}
  if(action==='create_company'||action==='create_job'){
    const isCompany=action==='create_company',table=isCompany?'companies':'job_listings',cols=isCompany?['created_by','name','website','verification_status']:['company_id','created_by','title','description','location','work_style','employment_type','salary_min','salary_max','status'];const values=isCompany?[body.created_by||req.auth.user_id,clean(body.name,160),clean(body.website,300)||null,body.verification_status||'pending']:[body.company_id,req.auth.user_id,clean(body.title,250),clean(body.description,20000),clean(body.location,250),clean(body.work_style,60)||'Flexible',clean(body.employment_type,80),body.salary_min||null,body.salary_max||null,body.status||'draft'];if(values.some(v=>v===undefined||v===''))return res.status(400).json({error:'Complete the required fields.'});const marks=values.map((_,i)=>`$${i+1}`).join(',');const {rows}=await pool.query(`insert into ${table}(${cols.join(',')}) values(${marks}) returning *`,values);await audit(req.auth.user_id,action,isCompany?'company':'job',rows[0].id);return res.json({row:rows[0]});
  }
  if(action==='update_membership'||action==='create_membership'){const status=body.status||'invited',role=body.role||'recruiter';if(!['company_admin','recruiter'].includes(role)||!['invited','active','suspended'].includes(status))return res.status(400).json({error:'Invalid membership role or status.'});if(status==='active'){const check=await pool.query(`select 1 from companies c, user_profiles p where c.id=$1 and p.id=$2 and c.verification_status='verified' and p.account_role='recruiter' and p.account_status='active'`,[body.company_id,body.user_id]);if(!check.rowCount)return res.status(400).json({error:'Active access requires a verified company and approved recruiter.'});}const {rows}=await pool.query(`insert into company_memberships(company_id,user_id,role,status) values($1,$2,$3,$4) on conflict(company_id,user_id) do update set role=excluded.role,status=excluded.status returning *`,[body.company_id,body.user_id,role,status]);await audit(req.auth.user_id,action,'company_membership',`${body.company_id}:${body.user_id}`,{role,status});return res.json({row:rows[0]});}
  return res.status(400).json({error:'Unknown admin action.'});
}catch(e){next(e)}}

app.use((err,_req,res,_next)=>{console.error('API request failed:',err.message);if(err instanceof multer.MulterError&&err.code==='LIMIT_FILE_SIZE')return res.status(413).json({error:'Resume file must be 5 MB or smaller.'});if(Number.isInteger(err.status)&&err.status>=400&&err.status<500)return res.status(err.status).json({error:err.message||'Check your request and try again.'});res.status(500).json({error:'The request could not be completed.'});});
if (!process.env.NETLIFY && !process.env.NETLIFY_DEV && !process.env.AWS_LAMBDA_FUNCTION_NAME) {
  app.listen(Number(process.env.PORT||3000),'0.0.0.0',()=>console.log(`HRs Portal Node API listening on ${process.env.PORT||3000}`));
}

export default app;
