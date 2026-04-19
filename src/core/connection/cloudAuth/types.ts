/**
 * Cloud IAM auth adapters (v1.5+). Implementations store tokens via SecretStorage only.
 */
export type CloudAuthKind = 'aws-iam' | 'azure-ad' | 'gcp-iam' | 'none';

export interface CloudAuthContext {
  kind: CloudAuthKind;
}
