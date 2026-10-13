create extension if not exists pgcrypto;

create table if not exists app_users (
  id uuid primary key default gen_random_uuid(),
  email text not null unique,
  password_hash text,
  email_verified_at timestamptz,
  created_at timestamptz not null default now(),
  last_sign_in_at timestamptz
);
create table if not exists user_profiles (
  id uuid primary key references app_users(id) on delete cascade,
  full_name text not null check (char_length(full_name) between 1 and 120),
  account_role text not null check (account_role in ('candidate','recruiter')),
  account_status text not null default 'pending_terms' check (account_status in ('pending_terms','pending_verification','pending_approval','active','suspended')),
  onboarding_completed_at timestamptz,
  terms_version text,
  terms_accepted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create table if not exists oauth_accounts (
  provider text not null,
  provider_subject text not null,
  user_id uuid not null references app_users(id) on delete cascade,
  provider_email text,
  created_at timestamptz not null default now(),
  primary key(provider, provider_subject)
);
create table if not exists auth_tokens (
  token_hash text primary key,
  user_id uuid not null references app_users(id) on delete cascade,
  purpose text not null check (purpose in ('verify_email','reset_password','invite')),
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);
create table if not exists auth_sessions (
  token_hash text primary key,
  user_id uuid not null references app_users(id) on delete cascade,
  mfa_verified boolean not null default false,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);
create index if not exists auth_sessions_user_id_idx on auth_sessions(user_id);
create table if not exists user_mfa (
  user_id uuid primary key references app_users(id) on delete cascade,
  secret text not null,
  verified_at timestamptz,
  created_at timestamptz not null default now()
);
create table if not exists oauth_states (
  state_hash text primary key,
  verifier text not null,
  provider text not null,
  portal text not null default 'candidate',
  link_user_id uuid references app_users(id) on delete cascade,
  expires_at timestamptz not null
);
alter table oauth_states add column if not exists portal text not null default 'candidate';

create table if not exists candidate_profiles (
  id uuid primary key references app_users(id) on delete cascade,
  full_name text not null,
  target_role text not null,
  location text not null,
  experience_level text not null,
  work_style text not null default 'Flexible',
  skills text[] not null default '{}',
  bio text not null default '' check (char_length(bio) <= 1000),
  expected_ctc_lpa numeric(8,2) check (expected_ctc_lpa is null or expected_ctc_lpa between 0 and 10000),
  visibility text not null default 'private' check (visibility in ('private','discoverable')),
  resume_key text not null,
  resume_name text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create table if not exists registration_resume_staging (
  user_id uuid primary key references app_users(id) on delete cascade,
  resume_key text not null,
  resume_name text not null,
  expires_at timestamptz not null default now() + interval '7 days',
  created_at timestamptz not null default now()
);
create table if not exists companies (
  id uuid primary key default gen_random_uuid(),
  created_by uuid not null references app_users(id) on delete restrict,
  name text not null,
  website text,
  verification_status text not null default 'pending' check (verification_status in ('pending','verified','rejected','suspended')),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table if not exists company_memberships (
  company_id uuid not null references companies(id) on delete cascade,
  user_id uuid not null references app_users(id) on delete cascade,
  role text not null check (role in ('company_admin','recruiter')),
  status text not null default 'invited' check (status in ('invited','active','suspended')),
  created_at timestamptz not null default now(), primary key(company_id,user_id)
);
create table if not exists job_listings (
  id uuid primary key default gen_random_uuid(), company_id uuid not null references companies(id),
  created_by uuid not null references app_users(id), title text not null, description text not null,
  location text not null, work_style text not null default 'Flexible', employment_type text not null,
  salary_min numeric, salary_max numeric,
  status text not null default 'draft' check (status in ('draft','pending_review','published','paused','closed')),
  published_at timestamptz, created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table if not exists job_applications (
  id uuid primary key default gen_random_uuid(), job_id uuid not null references job_listings(id) on delete cascade,
  candidate_id uuid not null references app_users(id) on delete cascade,
  status text not null default 'submitted' check (status in ('submitted','reviewing','interview','offer','rejected','withdrawn')),
  resume_shared boolean not null default false, recruiter_note text,
  resume_snapshot text,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique(job_id,candidate_id)
);
alter table candidate_profiles add column if not exists expected_ctc_lpa numeric(8,2) check (expected_ctc_lpa is null or expected_ctc_lpa between 0 and 10000);
alter table job_applications add column if not exists resume_snapshot text;
create table if not exists platform_admins (
  user_id uuid primary key references app_users(id) on delete cascade,
  role text not null check (role in ('admin','super_admin')),
  status text not null default 'invited' check (status in ('invited','active','suspended')),
  invited_by uuid references app_users(id), created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create table if not exists platform_audit_log (
  id bigserial primary key, actor_id uuid references app_users(id) on delete set null,
  action text not null, entity_type text not null, entity_id text,
  details jsonb not null default '{}', created_at timestamptz not null default now()
);
create or replace function prevent_platform_audit_mutation() returns trigger language plpgsql as $$
begin raise exception 'Audit history is append-only'; end $$;
drop trigger if exists platform_audit_log_immutable on platform_audit_log;
create trigger platform_audit_log_immutable before update or delete on platform_audit_log for each row execute function prevent_platform_audit_mutation();
