/**
 * Active egress and containment probes against the running candidate stack (infra/opendots/compose.candidates.yml).
 *
 * The probe program (probes/netguard-in-namespace.mjs) runs inside the guarded network namespace exactly as a
 * candidate would: ALL capabilities dropped, no-new-privileges, read-only root, small memory and pid limits. It joins
 * the namespace of the netguard sidecar with `--network container:<netguard>`. The lateral probe runs in the other
 * test container (`expunge-a1-neighbor`) that shares only the control bridge.
 *
 * This needs Docker, the running stack and the locally present node image (no image is ever pulled). It is
 * containment evidence for the local candidate profile, not a statement about any production network.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { containerRunning, dockerAvailable, imagePresent, liveGate } from './support.js';

const NETGUARD = process.env.EXPUNGE_NETGUARD_CONTAINER ?? 'expunge-a1-candidate-candidate-netguard-1';
const NEIGHBOR = process.env.EXPUNGE_NEIGHBOR_CONTAINER ?? 'expunge-a1-neighbor';
const IMAGE = process.env.EXPUNGE_PROBE_IMAGE ?? 'node:24.18.1-alpine';
const stackUp = dockerAvailable() && containerRunning(NETGUARD) && imagePresent(IMAGE);
const describeLive = liveGate(
  stackUp,
  `the candidate stack (${NETGUARD}) and image ${IMAGE}`,
  'docker, the netguard container or the probe image is not available',
);

type Probe = { id: string; verdict: 'blocked' | 'open' | 'answered' | 'info'; detail: string };
const PROBE_FILE = new URL('./probes/netguard-in-namespace.mjs', import.meta.url);

function runInNamespace(): Probe[] {
  const result = spawnSync(
    'docker',
    [
      'run',
      '-i',
      '--rm',
      '--pull=never',
      '--network',
      `container:${NETGUARD}`,
      '--cap-drop',
      'ALL',
      '--security-opt',
      'no-new-privileges:true',
      '--read-only',
      '--memory',
      '128m',
      '--pids-limit',
      '32',
      IMAGE,
      'node',
      '--input-type=module',
      '-',
    ],
    { input: readFileSync(PROBE_FILE), encoding: 'utf8', timeout: 150_000, maxBuffer: 8 * 1024 * 1024 },
  );
  if (result.status !== 0)
    throw new Error(`probe container failed (${result.status}): ${result.stderr.slice(0, 300)}`);
  return result.stdout
    .split('\n')
    .filter((line) => line.startsWith('{'))
    .map((line) => JSON.parse(line) as Probe);
}

const status = (probe: Probe | undefined): number[] =>
  probe ? (JSON.parse(probe.detail) as { status: number[] }).status : [];

describeLive('the guarded candidate namespace (probes run from inside it)', () => {
  let probes: Probe[];
  let byId: Map<string, Probe>;
  beforeAll(() => {
    probes = runInNamespace();
    byId = new Map(probes.map((p) => [p.id, p]));
    console.log(
      `netguard probes: ${probes.length} results; ${probes.filter((p) => p.verdict === 'open').length} open`,
    );
  }, 160_000);

  it('produced every probe (the program ran to the end, including the post-attack liveness check)', () => {
    expect(byId.has('inventory-tcp-listeners')).toBe(true);
    expect(byId.has('proxy-alive-after-crafted')).toBe(true);
    expect(probes.length).toBeGreaterThan(40);
  });

  it('no egress probe connected: nothing is "open" anywhere', () => {
    expect(probes.filter((p) => p.verdict === 'open').map((p) => `${p.id}: ${p.detail}`)).toEqual([]);
  });

  it('the namespace listens on nothing but the control port and the embedded resolver', () => {
    const listeners = JSON.parse(byId.get('inventory-tcp-listeners')!.detail) as Array<{
      family: number;
      addr: string;
      port: number;
    }>;
    const unexpected = listeners.filter(
      (l) =>
        !(l.port === 4100) && !(l.family === 4 && l.addr === '0B00007F') /* 127.0.0.11, Docker's resolver */,
    );
    expect(unexpected).toEqual([]);
    expect(byId.get('inventory-control-port-listening')!.verdict).toBe('info');
  });

  it('IPv6 (global, link-local, multicast) cannot leave', () => {
    for (const id of [
      'ipv6-tcp fe80::1%eth0',
      'ipv6-tcp fe80::1%lo',
      'ipv6-tcp 2606:4700:4700::1111',
      'ipv6-udp multicast ff02::1%eth0',
    ]) {
      expect(byId.get(id)?.verdict, id).toBe('blocked');
    }
  });

  it('ICMP echo works on loopback (positive control) and is dropped to the Internet, the proxy address and the gateway', () => {
    expect(byId.get('icmp-control ping 127.0.0.1')?.verdict).toBe('info');
    for (const id of ['icmp ping 1.1.1.1', 'icmp ping 172.30.90.2', 'icmp ping 172.19.0.1'])
      expect(byId.get(id)?.verdict, id).toBe('blocked');
  });

  it('only the pinned proxy port is reachable; every other destination and port is dropped', () => {
    expect(byId.get('tcp-control 172.30.90.2:4314')?.verdict).toBe('info');
    for (const id of [
      'tcp 1.1.1.1:443',
      'tcp 169.254.169.254:80',
      'tcp 172.19.0.1:80',
      'tcp 172.30.90.2:80',
      'tcp 172.30.90.2:4313',
      'tcp 172.30.90.2:4320',
    ]) {
      expect(byId.get(id)?.verdict, id).toBe('blocked');
    }
  });

  it('the embedded resolver is unreachable on port 53, on its DNAT high port over TCP, and public DNS is unreachable over UDP', () => {
    const highPort = probes.find((p) => /^dns-tcp 127\.0\.0\.11:\d{5}$/.test(p.id));
    expect(highPort, 'the resolver high port must have been discovered from /proc/net/tcp').toBeDefined();
    expect(highPort!.verdict).toBe('blocked');
    for (const id of [
      'dns-tcp-query example.com via high port',
      'dns-tcp 127.0.0.11:53',
      'dns-tcp 127.0.0.11:5353',
      'dns-udp 8.8.8.8:53',
    ]) {
      expect(byId.get(id)?.verdict, id).toBe('blocked');
    }
  });

  it('the control port needs the child credential: only /health answers anonymously, everything else is 401', () => {
    expect(status(byId.get('control-4100 GET /health no auth'))).toEqual([200]);
    for (const id of [
      'control-4100 POST /files/read no auth',
      'control-4100 POST /files/write no auth',
      'control-4100 GET / no auth',
      'control-4100 POST /files/read wrong bearer',
    ]) {
      expect(status(byId.get(id)), id).toEqual([401]);
    }
  });

  it('crafted request targets to the proxy never reach a broker: only 400, 403 or 431, nothing leaks, and it is alive afterwards', () => {
    const crafted = probes.filter((p) => p.id.startsWith('proxy-crafted '));
    expect(crafted.length).toBeGreaterThanOrEqual(15);
    for (const probe of crafted) {
      const detail = JSON.parse(probe.detail) as { status: number[]; leaked: boolean };
      expect(detail.leaked, probe.id).toBe(false);
      expect(detail.status.length, probe.id).toBeGreaterThan(0);
      for (const code of detail.status) expect([400, 403, 431], `${probe.id} -> ${code}`).toContain(code);
    }
    expect(status(byId.get('proxy-alive-after-crafted'))).toEqual([403]);
  });

  it('the rules in force match the design: default DROP on both families and the DNS drops sit before the first ACCEPT', () => {
    const rules = (tool: 'iptables' | 'ip6tables') => {
      const r = spawnSync('docker', ['exec', NETGUARD, tool, '-S'], { encoding: 'utf8', timeout: 15_000 });
      expect(r.status, `${tool} -S`).toBe(0);
      return r.stdout.split('\n').filter(Boolean);
    };
    for (const tool of ['iptables', 'ip6tables'] as const) {
      const lines = rules(tool);
      for (const chain of ['INPUT', 'OUTPUT', 'FORWARD']) expect(lines).toContain(`-P ${chain} DROP`);
      for (const chain of ['INPUT', 'OUTPUT']) {
        const own = lines.filter((l) => l.startsWith(`-A ${chain} `));
        const firstAccept = own.findIndex((l) => l.endsWith('-j ACCEPT'));
        const dnsDrops = own
          .map((l, i) => ({ l, i }))
          .filter(({ l }) => /(dport|sport) 53 -j DROP$/.test(l) || /127\.0\.0\.11\/32 -j DROP$/.test(l));
        expect(dnsDrops.length, `${tool} ${chain} DNS drops`).toBeGreaterThan(0);
        for (const { l, i } of dnsDrops) expect(i, `${tool} ${l}`).toBeLessThan(firstAccept);
      }
    }
    // The only inbound accept besides loopback and replies is the control port; the only outbound accept is the proxy.
    const v4 = rules('iptables');
    expect(
      v4.filter(
        (l) =>
          l.startsWith('-A INPUT') &&
          l.endsWith('-j ACCEPT') &&
          !l.includes('-i lo') &&
          !l.includes('conntrack'),
      ),
    ).toEqual(['-A INPUT -p tcp -m tcp --dport 4100 -j ACCEPT']);
    expect(
      v4.filter(
        (l) =>
          l.startsWith('-A OUTPUT') &&
          l.endsWith('-j ACCEPT') &&
          !l.includes('-o lo') &&
          !l.includes('conntrack'),
      ),
    ).toHaveLength(1);
    expect(v4.find((l) => l.includes('--dport 4314'))).toMatch(
      /^-A OUTPUT -d \d+\.\d+\.\d+\.\d+\/32 -p tcp -m tcp --dport 4314 -j ACCEPT$/,
    );
  });
});

const neighborUp = stackUp && containerRunning(NEIGHBOR);
const describeLateral = liveGate(
  neighborUp,
  `the lateral probe container (${NEIGHBOR})`,
  'neighbor container is not running',
);

describeLateral('a container on the control bridge (lateral movement toward the candidate namespace)', () => {
  const inspect = (container: string, template: string) => {
    const r = spawnSync('docker', ['inspect', '--format', template, container], {
      encoding: 'utf8',
      timeout: 5000,
    });
    return r.status === 0 ? r.stdout.trim() : '';
  };
  const neighborNetworks = inspect(
    NEIGHBOR,
    '{{range $k, $v := .NetworkSettings.Networks}}{{$k}}={{$v.IPAddress}} {{end}}',
  );
  const controlIp = inspect(
    NETGUARD,
    '{{range $k, $v := .NetworkSettings.Networks}}{{if eq $k "expunge-a1-candidate_candidate-control"}}{{$v.IPAddress}}{{end}}{{end}}',
  );

  it('can reach only the control port of the candidate namespace, and that port rejects anonymous and wrong-credential calls', () => {
    expect(controlIp, `netguard control address (neighbor networks: ${neighborNetworks})`).toMatch(
      /^\d+\.\d+\.\d+\.\d+$/,
    );
    const script = `
      const net = require('node:net');
      const ip = ${JSON.stringify(controlIp)};
      const tcp = (port) => new Promise((resolve) => { const s = net.connect({ host: ip, port }); s.setTimeout(2000, () => { s.destroy(); resolve('timeout'); }); s.once('connect', () => { s.destroy(); resolve('open'); }); s.once('error', (e) => resolve(e.code)); });
      const http = (method, path, headers) => fetch('http://' + ip + ':4100' + path, { method, headers, signal: AbortSignal.timeout(4000) }).then((r) => r.status, (e) => String(e.cause?.code ?? e.message));
      (async () => {
        const out = {};
        for (const port of [22, 80, 443, 3000, 4314, 4320, 9222, 27017]) out['tcp' + port] = await tcp(port);
        out.ctl = await tcp(4100);
        out.health = await http('GET', '/health', {});
        out.read = await http('POST', '/files/read', { 'content-type': 'application/json' });
        out.readWrongToken = await http('POST', '/files/read', { authorization: 'Bearer not-the-token', 'content-type': 'application/json' });
        console.log(JSON.stringify(out));
      })();`;
    const r = spawnSync('docker', ['exec', NEIGHBOR, 'node', '-e', script], {
      encoding: 'utf8',
      timeout: 60_000,
    });
    expect(r.status, r.stderr.slice(0, 200)).toBe(0);
    const out = JSON.parse(r.stdout.trim().split('\n').pop()!) as Record<string, string | number>;
    for (const port of [22, 80, 443, 3000, 4314, 4320, 9222, 27017])
      expect(out[`tcp${port}`], `tcp ${port}`).not.toBe('open');
    expect(out.ctl).toBe('open');
    expect(out.health).toBe(200);
    expect(out.read).toBe(401);
    expect(out.readWrongToken).toBe(401);
  }, 90_000);
});

export type { Probe };
describe('probe program', () => {
  it('is present beside the test', () => {
    expect(readFileSync(PROBE_FILE, 'utf8')).toContain('Active egress and containment probes');
  });
});
