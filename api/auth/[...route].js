// Catch-all router for /api/auth/* — keeps Hobby-plan function count under 12.

const { catchAllHead } = require('../_lib/catch-all-route');

const handlers = {
  device: require('../_lib/handlers/auth-device'),
  token: require('../_lib/handlers/auth-token'),
  refresh: require('../_lib/handlers/auth-refresh'),
  authorize: require('../_lib/handlers/auth-authorize'),
  session: require('../_lib/handlers/auth-session'),
  'device-bind': require('../_lib/handlers/auth-device-bind'),
  status: require('../_lib/handlers/auth-status'),
};

module.exports = async (req, res) => {
  const handler = handlers[catchAllHead(req, 'route', 'auth')];
  if (!handler) {
    return res.status(404).json({ error: 'Not Found' });
  }
  return handler(req, res);
};
