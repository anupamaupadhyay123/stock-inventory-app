// permissions.js
const ROLE_RIGHTS = {
  admin:  ['view', 'add', 'edit', 'delete', 'logs', 'users'],
  user:   ['view', 'add', 'edit'],   // no delete
  viewer: ['view']                   // view only
};

// Gets the logged-in user from wherever the app stores it
function getUser(req) {
  return req.user || (req.session && req.session.user) || req.auth || null;
}

// Use on routes: can('add'), can('edit'), can('delete'), can('logs')
function can(right) {
  return (req, res, next) => {
    const u = getUser(req);
    const role = (u && u.role) || 'viewer';
    if ((ROLE_RIGHTS[role] || []).includes(right)) return next();
    return res.status(403).json({ error: 'You do not have permission to do this' });
  };
}

// Writes an entry in the activity log (visible to admin)
async function logActivity(pool, req, action, module, details) {
  try {
    const u = getUser(req) || {};
    await pool.query(
      'INSERT INTO activity_logs (user_id, user_name, role, action, module, details) VALUES (?,?,?,?,?,?)',
      [u.id || null, u.full_name || u.username || null, u.role || null,
       action, module, typeof details === 'string' ? details : JSON.stringify(details)]
    );
  } catch (e) { console.error('Log error:', e.message); }
}

module.exports = { ROLE_RIGHTS, can, logActivity };