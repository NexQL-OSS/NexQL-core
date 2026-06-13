// Catch-all router for /api/sync/* — keeps Hobby-plan function count under 12.

const manifest = require('../_lib/handlers/sync-manifest');
const items = require('../_lib/handlers/sync-items');
const shares = require('../_lib/handlers/sync-shares');
const sharesById = require('../_lib/handlers/sync-shares-id');
const keys = require('../_lib/handlers/sync-keys');
const quota = require('../_lib/handlers/sync-quota');
const devices = require('../_lib/handlers/sync-devices');

function pathSegments(req) {
  const raw = req.query.path;
  if (Array.isArray(raw)) return raw;
  if (typeof raw === 'string' && raw) return [raw];
  return [];
}

module.exports = async (req, res) => {
  const segments = pathSegments(req);
  const [head, id] = segments;

  if (head === 'manifest' && segments.length === 1) {
    return manifest(req, res);
  }
  if (head === 'items' && segments.length === 2) {
    req.query.itemId = id;
    return items(req, res);
  }
  if (head === 'shares' && segments.length === 1) {
    return shares(req, res);
  }
  if (head === 'shares' && segments.length === 2) {
    req.query.shareId = id;
    return sharesById(req, res);
  }
  if (head === 'keys' && segments.length === 1) {
    return keys(req, res);
  }
  if (head === 'quota' && segments.length === 1) {
    return quota(req, res);
  }
  if (head === 'devices' && segments.length === 1) {
    return devices(req, res);
  }
  if (head === 'devices' && segments.length === 2) {
    req.query.deviceId = id;
    return devices(req, res);
  }

  return res.status(404).json({ error: 'Not Found' });
};
