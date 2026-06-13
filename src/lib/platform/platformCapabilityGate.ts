import type { PlatformCapabilities, PlatformProfile } from './PlatformProfile';

export type GatedCapability =
  | 'vacuum'
  | 'reindex'
  | 'tablespaces'
  | 'eventTriggers'
  | 'listenNotify'
  | 'pgCron'
  | 'sessionTransactions';

const CAPABILITY_MAP: Record<
  GatedCapability,
  keyof PlatformCapabilities
> = {
  vacuum: 'supportsVacuum',
  reindex: 'supportsReindex',
  tablespaces: 'supportsTablespaces',
  eventTriggers: 'supportsEventTriggers',
  listenNotify: 'supportsListenNotify',
  pgCron: 'supportsPgCron',
  sessionTransactions: 'sessionStateReliable',
};

export function isCapabilitySupported(
  profile: PlatformProfile | undefined,
  capability: GatedCapability,
): boolean {
  if (!profile) {
    return true;
  }
  return profile.capabilities[CAPABILITY_MAP[capability]];
}

export function capabilityBlockedMessage(
  profile: PlatformProfile,
  capability: GatedCapability,
): string {
  const label = profileDisplayAction(capability);
  return `${label} is not supported on ${profile.badge}. See docs/COMPATIBILITY.md for platform limits.`;
}

function profileDisplayAction(capability: GatedCapability): string {
  switch (capability) {
    case 'vacuum':
      return 'VACUUM';
    case 'reindex':
      return 'REINDEX';
    case 'tablespaces':
      return 'Tablespace operations';
    case 'eventTriggers':
      return 'Event triggers';
    case 'listenNotify':
      return 'LISTEN/NOTIFY';
    case 'pgCron':
      return 'pg_cron management';
    case 'sessionTransactions':
      return 'Multi-statement transactions';
  }
}

export async function assertPlatformCapability(
  profile: PlatformProfile | undefined,
  capability: GatedCapability,
): Promise<void> {
  if (!profile || isCapabilitySupported(profile, capability)) {
    return;
  }
  throw new Error(capabilityBlockedMessage(profile, capability));
}
