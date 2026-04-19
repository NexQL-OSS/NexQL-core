import { expect } from 'chai';
import { parseCloudAuth } from '../../core/connection/cloudAuth';

describe('parseCloudAuth', () => {
  it('returns none for undefined and invalid', () => {
    expect(parseCloudAuth(undefined).kind).to.equal('none');
    expect(parseCloudAuth(null).kind).to.equal('none');
    expect(parseCloudAuth({}).kind).to.equal('none');
    expect(parseCloudAuth({ kind: 'other' }).kind).to.equal('none');
  });

  it('accepts known IAM kinds', () => {
    expect(parseCloudAuth({ kind: 'aws-iam' }).kind).to.equal('aws-iam');
    expect(parseCloudAuth({ kind: 'azure-ad' }).kind).to.equal('azure-ad');
    expect(parseCloudAuth({ kind: 'gcp-iam' }).kind).to.equal('gcp-iam');
  });
});
