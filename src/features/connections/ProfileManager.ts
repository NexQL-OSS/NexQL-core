import * as vscode from 'vscode';
import { ConnectionConfig } from '../../common/types';
import { ConnectionManager } from '../../services/ConnectionManager';

/**
 * Connection profile with preset safety and performance settings.
 * Extends ConnectionConfig with role-based preferences.
 */
export interface ConnectionProfile extends ConnectionConfig {
  /** Profile name (e.g., "Read-Only Analyst", "DB Admin") */
  profileName: string;
  /** Profile description/use case */
  description?: string;
  /** Role-based preset settings */
  rolePresets?: {
    forceReadOnly?: boolean;
    autoApplySafetyCheck?: boolean;
    autoLimitSelectResults?: number; // 0 = disabled
  };
}

/**
 * Manages connection profiles: predefined connection templates with role-based settings.
 * Singleton service that persists profiles in VS Code globalState.
 */
export class ProfileManager {
  private static instance: ProfileManager;
  private context: vscode.ExtensionContext | null = null;
  private profiles: Map<string, ConnectionProfile> = new Map();
  private readonly STORAGE_KEY = 'postgres-explorer.connectionProfiles';

  private constructor() {}

  static getInstance(): ProfileManager {
    if (!ProfileManager.instance) {
      ProfileManager.instance = new ProfileManager();
    }
    return ProfileManager.instance;
  }

  /**
   * Initialize ProfileManager with extension context.
   * Must be called during extension activation.
   */
  initialize(context: vscode.ExtensionContext): void {
    this.context = context;
    this.loadProfiles();
  }

  /**
   * Load profiles from persistent storage.
   */
  private loadProfiles(): void {
    if (!this.context) {
      return;
    }
    const stored = this.context.globalState.get<ConnectionProfile[]>(this.STORAGE_KEY, []);
    this.profiles.clear();
    stored.forEach((profile) => {
      this.profiles.set(profile.id, profile);
    });
  }

  /**
   * Save profiles to persistent storage.
   */
  private async saveProfiles(): Promise<void> {
    if (!this.context) {
      return;
    }
    const profileArray = Array.from(this.profiles.values());
    await this.context.globalState.update(this.STORAGE_KEY, profileArray);
  }

  /**
   * Create or update a connection profile.
   */
  async createProfile(profile: ConnectionProfile): Promise<void> {
    this.profiles.set(profile.id, profile);
    await this.saveProfiles();
  }

  /**
   * Delete a connection profile by ID.
   */
  async deleteProfile(profileId: string): Promise<void> {
    this.profiles.delete(profileId);
    await this.saveProfiles();
  }

  /**
   * Get all profiles.
   */
  getProfiles(): ConnectionProfile[] {
    return Array.from(this.profiles.values());
  }

  /**
   * Get a profile by ID.
   */
  getProfile(profileId: string): ConnectionProfile | undefined {
    return this.profiles.get(profileId);
  }

  /**
   * Apply profile settings to a connection config.
   * Merges profile role presets into the connection.
   */
  applyProfile(baseConfig: ConnectionConfig, profileId: string): ConnectionConfig {
    const profile = this.getProfile(profileId);
    if (!profile) {
      return baseConfig;
    }

    return {
      ...baseConfig,
      ...profile,
      // Keep base config ID/secrets, override only connection details
      password: baseConfig.password, // Preserve original password if not in profile
    };
  }

  /**
   * Initialize with built-in role presets.
   * Call this once after extension loads to populate default profiles.
   */
  async initializeDefaultProfiles(): Promise<void> {
    if (this.profiles.size > 0) {
      return; // Already initialized
    }

    const readOnlyAnalyst: ConnectionProfile = {
      id: 'profile-readonly-analyst',
      name: 'Read-Only Analyst',
      profileName: 'Read-Only Analyst',
      description: 'Safe read-only access for data analysts',
      host: 'localhost',
      port: 5432,
      readOnlyMode: true,
      rolePresets: {
        forceReadOnly: true,
        autoApplySafetyCheck: true,
        autoLimitSelectResults: 1000,
      },
    };

    const dbAdmin: ConnectionProfile = {
      id: 'profile-db-admin',
      name: 'DB Admin',
      profileName: 'DB Admin',
      description: 'Full access for database administrators',
      host: 'localhost',
      port: 5432,
      readOnlyMode: false,
      rolePresets: {
        forceReadOnly: false,
        autoApplySafetyCheck: true,
        autoLimitSelectResults: 0, // No auto-limit
      },
    };

    const stagingEnv: ConnectionProfile = {
      id: 'profile-staging-dev',
      name: 'Staging Dev',
      profileName: 'Staging Dev',
      description: 'Development connection on staging server',
      host: 'staging.example.com',
      port: 5432,
      environment: 'staging',
      readOnlyMode: false,
      rolePresets: {
        forceReadOnly: false,
        autoApplySafetyCheck: true,
        autoLimitSelectResults: 500,
      },
    };

    const prodReadOnly: ConnectionProfile = {
      id: 'profile-prod-readonly',
      name: 'Production Read-Only',
      profileName: 'Production Read-Only',
      description: 'Read-only access to production (safeguarded)',
      host: 'prod.example.com',
      port: 5432,
      environment: 'production',
      readOnlyMode: true,
      rolePresets: {
        forceReadOnly: true,
        autoApplySafetyCheck: true,
        autoLimitSelectResults: 100,
      },
    };

    await this.createProfile(readOnlyAnalyst);
    await this.createProfile(dbAdmin);
    await this.createProfile(stagingEnv);
    await this.createProfile(prodReadOnly);
  }

  /**
   * Get profile suggestion based on connection config (for UI hints).
   * Returns the most relevant profile role for a given connection.
   */
  suggestProfile(config: ConnectionConfig): ConnectionProfile | undefined {
    const profiles = this.getProfiles();

    // Match by environment
    if (config.environment === 'production' && config.readOnlyMode) {
      return profiles.find((p) => p.id === 'profile-prod-readonly');
    }
    if (config.readOnlyMode) {
      return profiles.find((p) => p.id === 'profile-readonly-analyst');
    }
    if (config.environment === 'staging') {
      return profiles.find((p) => p.id === 'profile-staging-dev');
    }

    return profiles.find((p) => p.id === 'profile-db-admin');
  }
}
