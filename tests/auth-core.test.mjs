import test from 'node:test';
import assert from 'node:assert/strict';
import {
  destinationForProfile,
  maskEmail,
  normalizeEmail,
  safeInternalRedirect,
  validateEmail,
  validateLogin,
  validatePassword,
  validateRegistration,
} from '../dist/auth-core.mjs';

test('normalizes email without accepting malformed addresses', () => {
  assert.equal(normalizeEmail('  Person@Example.com '), 'person@example.com');
  assert.equal(validateEmail('person@example.com'), true);
  assert.equal(validateEmail('bad-address'), false);
});

test('login requires a valid email and nonempty password without trimming the password', () => {
  assert.equal(validateLogin({ email: ' ADA@example.com ', password: ' x ' }).valid, true);
  assert.deepEqual(validateLogin({ email: 'bad', password: '' }).errors, {
    email: 'Enter a valid email address.',
    password: 'Enter your password.',
  });
});

test('password policy keeps entered characters and accepts long passphrases', () => {
  assert.equal(validatePassword('  twelve chars  '), true);
  assert.equal(validatePassword('short'), false);
});

test('registration validates all required inputs and allowlisted roles', () => {
  const result = validateRegistration({ fullName: '  Ada Lovelace ', email: ' ADA@example.com ', password: 'correct horse battery staple', confirmPassword: 'correct horse battery staple', role: 'candidate', acceptedTerms: true });
  assert.equal(result.valid, true);
  assert.deepEqual(result.value, { fullName: 'Ada Lovelace', email: 'ada@example.com', role: 'candidate' });
  assert.equal(validateRegistration({ fullName: 'X', email: 'x@x.co', password: 'long enough password', confirmPassword: 'different password', role: 'admin', acceptedTerms: false }).valid, false);
});

test('redirect validation rejects external, protocol-relative, and backslash redirects', () => {
  assert.equal(safeInternalRedirect('/candidate/dashboard?q=a#tab'), '/candidate/dashboard?q=a#tab');
  assert.equal(safeInternalRedirect('//evil.example'), '/');
  assert.equal(safeInternalRedirect('https://evil.example'), '/');
  assert.equal(safeInternalRedirect('/\\evil.example'), '/');
});

test('routes only approved recruiters to recruiter workspace', () => {
  assert.equal(destinationForProfile({ account_role: 'recruiter', account_status: 'pending' }), '/?auth=pending');
  assert.equal(destinationForProfile({ account_role: 'recruiter', account_status: 'active' }), '/?view=recruiter');
  assert.equal(destinationForProfile({ account_role: 'candidate', account_status: 'active' }), '/?view=jobs');
});

test('email verification message masks the local part', () => {
  assert.equal(maskEmail('alex.morgan@example.com'), 'a•••@example.com');
  assert.equal(maskEmail('not-an-email'), '');
});
