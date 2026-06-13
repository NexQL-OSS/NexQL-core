// GET /api/sync/devices — list devices for the signed-in account.
// DELETE /api/sync/devices/:deviceId — revoke a device roster entry.

const { authenticateBearer } = require('../sync-auth');
const { listDevices, revokeDevice } = require('../sync-db');

module.exports = async (req, res) => {
  let auth;
  try {
    auth = await authenticateBearer(req);
  } catch (err) {
    console.error('sync/devices auth:', err);
    return res.status(500).json({ error: 'Auth unavailable' });
  }
  if (!auth) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  if (req.method === 'GET') {
    try {
      const rows = await listDevices(auth.account_id);
      return res.status(200).json(rows.map((r) => ({
        device_id: r.device_id,
        device_name: r.device_name,
        last_seen: r.last_seen instanceof Date
          ? r.last_seen.toISOString()
          : new Date(r.last_seen).toISOString(),
      })));
    } catch (err) {
      console.error('sync/devices GET:', err);
      return res.status(500).json({ error: 'Failed to list devices' });
    }
  }

  if (req.method === 'DELETE') {
    const deviceId = req.query.deviceId;
    if (!deviceId) {
      return res.status(400).json({ error: 'deviceId is required' });
    }
    try {
      const ok = await revokeDevice(auth.account_id, String(deviceId));
      if (!ok) {
        return res.status(404).json({ error: 'Device not found' });
      }
      return res.status(204).end();
    } catch (err) {
      console.error('sync/devices DELETE:', err);
      return res.status(500).json({ error: 'Failed to revoke device' });
    }
  }

  return res.status(405).json({ error: 'Method Not Allowed' });
};
