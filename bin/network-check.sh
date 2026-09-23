#!/bin/sh
# network-check.sh — why Docker cannot publish a port, in facts safe to print.
#
# Run on the server by the Server workflow's `network-check` action, piped
# over ssh like setup-postgis.sh, so it leaves nothing behind. It changes
# nothing: every command here only reads.
#
# The question it answers is the deploy that fails with
#
#   iptables: No chain/target/match by that name
#
# which means the `DOCKER` chain Docker keeps in the `nat` table is gone. The
# usual reasons are a firewall reload that flushes everything, an upgrade that
# switched iptables between its nf_tables and legacy backends, or a kernel
# upgraded under the running system. Each shows up below.
#
# The output lands in public Actions logs. So it prints yes/no facts, versions
# and package names — never the firewall rules themselves, which can hold an
# allowlisted home address — and any address that reaches a line anyway is
# redacted.

set -u

has() { command -v "$1" >/dev/null 2>&1; }
# IPv4, IPv6 written in full, and IPv6 with a :: in it. A time of day has too
# few colons to be taken for an address, and is left alone.
redact() {
  sed -E 's/[0-9]{1,3}(\.[0-9]{1,3}){3}(\/[0-9]+)?/<address>/g
          s/[0-9a-fA-F]{0,4}(:[0-9a-fA-F]{0,4})*::[0-9a-fA-F:]*[0-9a-fA-F](\/[0-9]+)?/<address>/g
          s/([0-9a-fA-F]{1,4}:){3,7}[0-9a-fA-F]{1,4}(\/[0-9]+)?/<address>/g'
}
# The journal's short form, without the host name, which is nobody's business.
nohost() { sed -E 's/^([^ ]+) [^ ]+ /\1 /'; }

# Reading iptables needs root; a deploy user that is not root may have sudo.
as_root() { if [ "$(id -u)" = 0 ]; then "$@"; else sudo -n "$@"; fi; }

chain() {
  if ! has "$1"; then echo 'not installed'; return; fi
  if as_root "$1" -w -t nat -S DOCKER >/dev/null 2>&1; then echo 'present'; else echo 'missing'; fi
}

echo '--- iptables ---'
if has iptables; then
  case "$(as_root iptables --version 2>/dev/null)" in
    *nf_tables*) echo 'backend: nf_tables' ;;
    *legacy*)    echo 'backend: legacy' ;;
    *)           echo 'backend: unknown' ;;
  esac
else
  echo 'iptables: not installed'
fi
echo "nat DOCKER chain, iptables: $(chain iptables)"
echo "nat DOCKER chain, iptables-nft: $(chain iptables-nft)"
echo "nat DOCKER chain, iptables-legacy: $(chain iptables-legacy)"
if has update-alternatives; then
  update-alternatives --query iptables 2>/dev/null | sed -n 's/^Value: /iptables alternative: /p'
fi

echo
echo '--- kernel ---'
running=$(uname -r)
echo "running: $running"
if [ -d "/lib/modules/$running" ]; then echo 'its modules on disk: yes'; else echo 'its modules on disk: NO — reboot to the installed kernel'; fi
if [ -f /var/run/reboot-required ]; then echo 'reboot required: yes'; else echo 'reboot required: no'; fi
for m in nf_nat iptable_nat nft_chain_nat xt_nat xt_addrtype; do
  if grep -q "^$m " /proc/modules 2>/dev/null; then echo "module $m: loaded"; else echo "module $m: not loaded"; fi
done

echo
echo '--- firewall services ---'
if has systemctl; then
  for s in nftables firewalld netfilter-persistent ufw fail2ban; do
    state=$(systemctl is-active "$s" 2>/dev/null)
    echo "$s: ${state:-unknown}"
  done
fi
if [ -f /etc/nftables.conf ] && grep -q 'flush ruleset' /etc/nftables.conf; then
  echo '/etc/nftables.conf flushes the whole ruleset: yes'
else
  echo '/etc/nftables.conf flushes the whole ruleset: no'
fi
if has journalctl; then
  echo 'starts, stops and reloads in the last three days:'
  journalctl --since '-3 days' --no-pager -o short-iso \
    -u docker -u nftables -u firewalld -u netfilter-persistent -u ufw 2>/dev/null \
    | grep -E 'Started|Stopped|Reload|Starting|Stopping|Deactivated' \
    | tail -n 12 | nohost | cut -c1-200 | redact
fi

echo
echo '--- docker ---'
if has docker; then
  version=$(docker version --format '{{.Server.Version}}' 2>/dev/null | head -n 1)
  echo "server version: ${version:-unknown}"
fi
if [ -f /etc/docker/daemon.json ]; then
  found=$(grep -oE '"(iptables|ip6tables|firewall-backend|userland-proxy)"[[:space:]]*:[[:space:]]*[^,}]+' /etc/docker/daemon.json)
  if [ -n "$found" ]; then printf '%s\n' "$found" | sed 's/^/daemon.json: /'; else echo 'daemon.json: no firewall settings'; fi
else
  echo 'daemon.json: none'
fi
if has journalctl; then
  echo 'what Docker last said about the firewall:'
  journalctl -u docker --since '-3 days' --no-pager -o short-iso 2>/dev/null \
    | grep -iE 'iptables|nftables|firewall|nat chain' \
    | tail -n 8 | nohost | cut -c1-300 | redact
fi

echo
echo '--- upgrades in the last three days, firewall and kernel packages only ---'
if [ -f /var/log/apt/history.log ]; then
  since=$(date -d '3 days ago' +%Y-%m-%d 2>/dev/null || echo '')
  awk -v since="$since" '
    /^Start-Date:/ { day = $2; keep = (since == "" || day >= since) }
    keep && /^(Upgrade|Install|Remove|Purge):/ {
      kind = $1
      line = $0
      sub(/^[A-Za-z]+: /, "", line)
      n = split(line, pkgs, /\), /)
      for (i = 1; i <= n; i++) {
        p = pkgs[i]
        if (p ~ /^(docker|containerd|iptables|nftables|firewalld|netfilter-persistent|ufw|linux-image|linux-modules)/) {
          if (p !~ /\)$/) p = p ")"
          print day " " kind " " p
        }
      }
    }' /var/log/apt/history.log | tail -n 20
else
  echo 'no apt history on this system'
fi
