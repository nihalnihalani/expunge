import { createHmac } from 'node:crypto';
import { canonicalJson } from '@expunge/contracts';

/**
 * Opaque labels under the campaign key. Every identifier a port, a worker or a stored row can see for a pair, an arm
 * or an instance is one of these, so none of them can be reproduced by enumerating the plan's fixture ids, splits,
 * arms and repeats (DA-8 D8-6). The key is the campaign's private HMAC key, readable only by the fixture builder and
 * the grader.
 */
export type Labeler = (domain: string, value: unknown, length?: number) => string;

export function labeler(key: Uint8Array): Labeler {
  if (!(key instanceof Uint8Array) || key.length < 32) throw new Error('InvalidCampaignKey');
  return (domain, value, length = 40) => {
    if (!/^[a-z0-9_-]{1,32}$/.test(domain)) throw new Error('InvalidLabelDomain');
    return createHmac('sha256', key)
      .update(`expunge:gate:1:${domain}\n`)
      .update(canonicalJson(value))
      .digest('hex')
      .slice(0, length);
  };
}
