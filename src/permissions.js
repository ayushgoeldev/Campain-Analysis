// Centralized role-based permission configuration.
// Add/edit roles and permissions here only — no other file should hardcode role checks.

export const ROLE_PERMISSIONS = {
  admin: [
    'report', 'data', 'setup', 'mappings', 'duplicates',
    'bifurcation', 'app-settings',
    'wd-report', 'wd-setup', 'wd-datasets',
    'datasets-delete', 'datasets-manage', 'recompute',
    'bifurcation-manage', 'clients-create', 'clients-delete',
    'audit-log', 'export',
  ],
  user: [
    'report', 'data', 'setup', 'mappings', 'duplicates',
    'recompute', 'wd-report', 'wd-setup',
    'clients-create', 'export',
  ],
};

export function hasPermission(role, permission) {
  const perms = ROLE_PERMISSIONS[role] || ROLE_PERMISSIONS['user'] || [];
  return perms.includes(permission);
}

// Express middleware factory — uses req.sessionRole set by requireAuth.
export function requirePermission(permission) {
  return (req, res, next) => {
    if (hasPermission(req.sessionRole || 'user', permission)) return next();
    return res.status(403).json({ error: 'Access denied', required: permission });
  };
}
