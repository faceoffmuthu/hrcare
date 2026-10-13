import test from 'node:test';
import assert from 'node:assert/strict';
import { canAccessLoginPortal } from '../backend/src/portal-access.js';

const candidate = { accountRole: 'candidate', accountStatus: 'active' };
const recruiter = { accountRole: 'recruiter', accountStatus: 'active' };
const admin = { platformRole: 'admin', platformStatus: 'active' };
const superAdmin = { platformRole: 'super_admin', platformStatus: 'active' };

test('public and role-specific portals keep platform admins off public sign-in', () => {
  assert.equal(canAccessLoginPortal('public', candidate), true);
  assert.equal(canAccessLoginPortal('candidate', candidate), true);
  assert.equal(canAccessLoginPortal('candidate', recruiter), false);
  assert.equal(canAccessLoginPortal('public', admin), false);
  assert.equal(canAccessLoginPortal('admin', admin), true);
  assert.equal(canAccessLoginPortal('super_admin', superAdmin), true);
  assert.equal(canAccessLoginPortal('admin', superAdmin), false);
});

test('company access requires an active company-admin membership at a verified company', () => {
  const companyAdmin = { ...recruiter, membershipRole: 'company_admin', membershipStatus: 'active', companyStatus: 'verified' };
  assert.equal(canAccessLoginPortal('company', companyAdmin), true);
  assert.equal(canAccessLoginPortal('company', { ...companyAdmin, companyStatus: 'pending' }), false);
  assert.equal(canAccessLoginPortal('company', { ...companyAdmin, membershipRole: 'recruiter' }), false);
  assert.equal(canAccessLoginPortal('company', { ...companyAdmin, accountStatus: 'suspended' }), false);
});

test('portal access accepts the PostgreSQL snake-case rows returned by the API', () => {
  assert.equal(canAccessLoginPortal('candidate', { account_role: 'candidate', account_status: 'active' }), true);
  assert.equal(canAccessLoginPortal('super_admin', { platform_role: 'super_admin', platform_status: 'active' }), true);
  assert.equal(canAccessLoginPortal('company', { account_role: 'recruiter', account_status: 'active', membership_role: 'company_admin', membership_status: 'active', company_status: 'verified' }), true);
});
