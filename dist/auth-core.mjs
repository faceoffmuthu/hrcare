export const PASSWORD_MIN_LENGTH = 12;
export const TERMS_VERSION = '2026-10-01';

export function normalizeEmail(value) {
  return String(value ?? '').trim().toLowerCase();
}

export function validateEmail(value) {
  const email = normalizeEmail(value);
  return email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

export function validatePassword(value) {
  return typeof value === 'string' && value.length >= PASSWORD_MIN_LENGTH && value.length <= 1024;
}

export function validateLogin(input) {
  const errors = {};
  const email = normalizeEmail(input?.email);
  if (!validateEmail(email)) errors.email = 'Enter a valid email address.';
  if (typeof input?.password !== 'string' || input.password.length === 0) errors.password = 'Enter your password.';
  return { valid: Object.keys(errors).length === 0, errors, value: { email, password: input?.password ?? '' } };
}

export function validateRegistration(input) {
  const errors = {};
  const fullName = String(input?.fullName ?? '').trim();
  const email = normalizeEmail(input?.email);
  const role = String(input?.role ?? '');
  if (!fullName) errors.fullName = 'Enter your full name.';
  else if (fullName.length > 120) errors.fullName = 'Use 120 characters or fewer.';
  if (!validateEmail(email)) errors.email = 'Enter a valid email address.';
  if (!validatePassword(input?.password)) errors.password = `Use at least ${PASSWORD_MIN_LENGTH} characters.`;
  if (input?.password !== input?.confirmPassword) errors.confirmPassword = 'Passwords do not match.';
  if (!['candidate', 'recruiter'].includes(role)) errors.role = 'Choose Candidate or Recruiter.';
  if (input?.acceptedTerms !== true) errors.acceptedTerms = 'Accept the Terms and Privacy Policy to continue.';
  return { valid: Object.keys(errors).length === 0, errors, value: { fullName, email, role } };
}

export function safeInternalRedirect(value, fallback = '/') {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//') || value.includes('\\')) return fallback;
  try {
    const parsed = new URL(value, 'https://hrs-portal.invalid');
    if (parsed.origin !== 'https://hrs-portal.invalid') return fallback;
    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return fallback;
  }
}

export function destinationForProfile(profile) {
  if (!profile || profile.account_status !== 'active') return '/?auth=pending';
  if (profile.account_role === 'recruiter') return '/?view=recruiter';
  return '/?view=jobs';
}

export function maskEmail(value) {
  const email = normalizeEmail(value);
  const [name, domain] = email.split('@');
  if (!name || !domain) return '';
  return `${name.slice(0, 1)}${name.length > 1 ? '•••' : '•••'}@${domain}`;
}
