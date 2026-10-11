#!/bin/sh
set -eu
# This sidecar alone has NET_ADMIN. Candidate programs share its network
# namespace but have ALL capabilities dropped and no-new-privileges set.
case "${PROXY_IPV4:-}" in
  ''|*[!0-9.]*) echo 'Set a numeric trusted proxy IPv4 address.' >&2; exit 1 ;;
esac
case "${PROXY_PORT:-}" in
  ''|*[!0-9]*) echo 'Set the trusted proxy TCP port.' >&2; exit 1 ;;
esac
iptables -P INPUT DROP
iptables -P OUTPUT DROP
iptables -P FORWARD DROP
iptables -F INPUT
iptables -F OUTPUT
iptables -F FORWARD
# Name resolution is never needed: the candidate reaches only the fixed proxy IP and
# `candidate-proxy` is pinned in /etc/hosts. DNS is also an exfiltration channel. Docker's
# embedded resolver (127.0.0.11) is reached over loopback and dockerd forwards its queries
# upstream whenever the namespace shares a non-internal bridge, so the loopback ACCEPT below
# would otherwise let it through. Docker's nat DNAT rewrites a query for 127.0.0.11:53 to
# 127.0.0.11:<high port> BEFORE the filter table runs, so these rules match the ADDRESS and
# also drop any destination port 53 on every interface including lo. They precede every ACCEPT.
iptables -A OUTPUT -d 127.0.0.11 -j DROP
iptables -A INPUT -s 127.0.0.11 -j DROP
iptables -A OUTPUT -p udp --dport 53 -j DROP
iptables -A OUTPUT -p tcp --dport 53 -j DROP
iptables -A INPUT -p udp --sport 53 -j DROP
iptables -A INPUT -p tcp --sport 53 -j DROP
iptables -A INPUT -i lo -j ACCEPT
iptables -A OUTPUT -o lo -j ACCEPT
iptables -A INPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
iptables -A OUTPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
# Bound computer control remains authenticated by the OpenBot child token.
iptables -A INPUT -p tcp --dport 4100 -j ACCEPT
iptables -A OUTPUT -d "$PROXY_IPV4" -p tcp --dport "$PROXY_PORT" -j ACCEPT
# Close IPv6 bypasses as well; startup fails if policy cannot be installed.
ip6tables -P INPUT DROP
ip6tables -P OUTPUT DROP
ip6tables -P FORWARD DROP
ip6tables -F INPUT
ip6tables -F OUTPUT
ip6tables -F FORWARD
# Docker publishes no IPv6 embedded resolver, but drop port 53 on every interface (lo included).
ip6tables -A OUTPUT -p udp --dport 53 -j DROP
ip6tables -A OUTPUT -p tcp --dport 53 -j DROP
ip6tables -A INPUT -p udp --sport 53 -j DROP
ip6tables -A INPUT -p tcp --sport 53 -j DROP
ip6tables -A INPUT -i lo -j ACCEPT
ip6tables -A OUTPUT -o lo -j ACCEPT
ip6tables -A INPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
ip6tables -A OUTPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
ip6tables -A INPUT -p tcp --dport 4100 -j ACCEPT
# Fail closed: refuse to become ready unless every DNS DROP is installed AND sits before the first
# ACCEPT of its chain. `iptables -C` only proves a rule exists; ordering is read from `-S` output
# (policy line is line 1, rules follow in evaluation order).
rule_line() { # rule_line <iptables|ip6tables> <chain> <fixed-string> -> first matching line number or empty
  "$1" -S "$2" | grep -n -F -m1 -- "$3" | cut -d: -f1
}
assert_before_first_accept() { # <iptables|ip6tables> <chain> <fixed-string of the DROP rule>
  drop=$(rule_line "$1" "$2" "$3")
  accept=$(rule_line "$1" "$2" '-j ACCEPT')
  if [ -z "$drop" ] || [ -z "$accept" ] || [ "$drop" -ge "$accept" ]; then
    echo "netguard: DNS drop '$3' missing or not ahead of the first ACCEPT in $1 $2" >&2
    exit 1
  fi
}
assert_before_first_accept iptables OUTPUT '-d 127.0.0.11/32 -j DROP'
assert_before_first_accept iptables OUTPUT '-p udp -m udp --dport 53 -j DROP'
assert_before_first_accept iptables OUTPUT '-p tcp -m tcp --dport 53 -j DROP'
assert_before_first_accept iptables INPUT '-s 127.0.0.11/32 -j DROP'
assert_before_first_accept ip6tables OUTPUT '-p udp -m udp --dport 53 -j DROP'
assert_before_first_accept ip6tables OUTPUT '-p tcp -m tcp --dport 53 -j DROP'
touch /run/ready
trap 'exit 0' TERM INT
while :; do sleep 3600 & wait $!; done
