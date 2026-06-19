// GET /api/sync/devices — list devices for the signed-in account.
// PATCH /api/sync/devices/:deviceId — rename this device (body: { device_name }).
// DELETE /api/sync/devices/:deviceId — revoke a device roster entry.

const { authenticateBearer } = require('../sync-auth');
const { listDevices, revokeDevice, updateDeviceName } = require('../sync-db');

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

  if (req.method === 'PATCH') {
    const deviceId = req.query.deviceId;
    const deviceName = req.body?.device_name;
    if (!deviceId) {
      return res.status(400).json({ error: 'deviceId is required' });
    }
    const callerDeviceId = req.headers['x-device-id'] || req.headers['X-Device-Id'];
    if (!callerDeviceId || String(callerDeviceId) !== String(deviceId)) {
      return res.status(403).json({ error: 'Can only rename this device' });
    }
    try {
      const ok = await updateDeviceName(auth.account_id, String(deviceId), deviceName);
      if (!ok) {
        return res.status(400).json({ error: 'device_name is required' });
      }
      return res.status(200).json({ ok: true, device_id: String(deviceId), device_name: String(deviceName).trim() });
    } catch (err) {
      console.error('sync/devices PATCH:', err);
      return res.status(500).json({ error: 'Failed to rename device' });
    }
  }

  return res.status(405).json({ error: 'Method Not Allowed' });
};
