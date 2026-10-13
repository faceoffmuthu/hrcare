export const LOGIN_PORTALS = Object.freeze([
  'public',
  'candidate',
  'recruiter',
  'company',
  'admin',
  'super_admin',
]);

export function canAccessLoginPortal(portal, account = {}) {
  const accountRole = account.accountRole ?? account.account_role;
  const accountStatus = account.accountStatus ?? account.account_status;
  const platformRole = account.platformRole ?? account.platform_role;
  const platformStatus = account.platformStatus ?? account.platform_status;
  const membershipRole = account.membershipRole ?? account.membership_role;
  const membershipStatus = account.membershipStatus ?? account.membership_status;
  const companyStatus = account.companyStatus ?? account.company_status;
  if (accountStatus === 'suspended' || platformStatus === 'suspended') return false;

  switch (portal) {
    case 'public':
      return !['admin', 'super_admin'].includes(platformRole) && ['candidate', 'recruiter'].includes(accountRole);
    case 'candidate':
      return accountRole === 'candidate';
    case 'recruiter':
      return accountRole === 'recruiter';
    case 'company':
      return accountRole === 'recruiter' && membershipRole === 'company_admin'
        && membershipStatus === 'active' && companyStatus === 'verified';
    case 'admin':
      return platformRole === 'admin' && ['active', 'invited'].includes(platformStatus);
    case 'super_admin':
      return platformRole === 'super_admin' && platformStatus === 'active';
    default:
      return false;
  }
}
