#!/bin/sh
# DA-1 repro: the candidate network namespace still performs recursive DNS through Docker's embedded resolver
# (127.0.0.11 over loopback, which netguard.sh accepts), i.e. a DNS exfiltration channel to the public Internet.
# Uses a throwaway probe container with the candidate's own constraints, joined to the running guarded namespace
# (same method BUILD-A1 used). Exit 0 = defect reproduced, 1 = not reproduced, 2 = environment missing.
# Run: sh docs/review/repro/cand-dns.repro.sh [netguard-container-name]
set -u
NETNS="${1:-expunge-a1-candidate-candidate-netguard-1}"
docker inspect "$NETNS" >/dev/null 2>&1 || { echo "netguard container $NETNS not running"; exit 2; }
docker run --rm --network "container:$NETNS" --cap-drop ALL --security-opt no-new-privileges:true \
  --read-only --memory 128m --pids-limit 32 node:24.18.1-alpine node -e '
const dns = require("node:dns").promises; const net = require("node:net");
const timeout = (p, ms) => Promise.race([p, new Promise((_, r) => setTimeout(() => r(new Error("timeout")), ms))]);
(async () => {
  const conf = require("node:fs").readFileSync("/etc/resolv.conf", "utf8").split("\n").filter(l => l.startsWith("nameserver")).join(" ");
  console.log("resolv.conf:", conf);
  let embedded = "blocked";
  try { embedded = (await timeout(dns.resolve4("example.com"), 5000)).join(","); } catch (e) { embedded = "blocked(" + e.code + "/" + e.message + ")"; }
  console.log("embedded resolver example.com A:", embedded);
  const direct = new (require("node:dns").promises.Resolver)({ timeout: 2000, tries: 1 }); direct.setServers(["1.1.1.1"]);
  let publicDns = "blocked"; try { publicDns = (await timeout(direct.resolve4("example.com"), 5000)).join(","); } catch (e) { publicDns = "blocked(" + (e.code || e.message) + ")"; }
  console.log("direct 1.1.1.1:53:", publicDns);
  const ip = embedded.startsWith("blocked") ? "1.1.1.1" : embedded.split(",")[0];
  const tcp = await new Promise(res => { const s = net.connect({ host: ip, port: 443 }); s.setTimeout(3000, () => { s.destroy(); res("blocked(timeout)"); }); s.on("connect", () => { s.destroy(); res("OPEN"); }); s.on("error", e => res("blocked(" + e.code + ")")); });
  console.log("tcp " + ip + ":443:", tcp);
  process.exit(embedded.startsWith("blocked") ? 1 : 0);
})();'
code=$?
if [ "$code" -eq 0 ]; then echo REPRODUCED; else echo "NOT REPRODUCED (probe exit $code)"; fi
exit "$code"
