// Catch-all router for /api/ai/* — keeps Hobby-plan function count under 12.

const { catchAllHead } = require('../_lib/catch-all-route');

const handlers = {
  chat: require('../_lib/handlers/ai-chat'),
  usage: require('../_lib/handlers/ai-usage'),
};

module.exports = async (req, res) => {
  const handler = handlers[catchAllHead(req, 'route', 'ai')];
  if (!handler) {
    return res.status(404).json({ error: 'Not Found' });
  }
  return handler(req, res);
};
