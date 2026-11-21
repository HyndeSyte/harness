#!/bin/bash
# The panel's terminal, one per connection (ttyd starts it, as root): it attaches to Cain's
# session as the user that session runs as. In the new way that's his own user, through
# as-cain with a clean environment and attach -E, so no root process is ever a client of his
# tmux (C1 plan 3.3: a tmux server's owner can make its clients run commands).
mode=""
for _ in $(seq 1 120); do
  mode="$(head -c 10 /run/cain/mode 2>/dev/null)"
  [ -n "$mode" ] && break
  sleep 1
done
case "$mode" in
  own)
    exec /opt/cain/as-cain bash -c 'until tmux -u -S /run/cain/tmux/cain.sock has-session -t cain 2>/dev/null; do sleep 1; done
exec tmux -u -S /run/cain/tmux/cain.sock attach-session -E -t cain' ;;
  old)
    exec bash -c 'until tmux -u has-session -t cain 2>/dev/null; do sleep 1; done; exec tmux -u attach -t cain' ;;
  *)
    echo "Cain isn't running right now. The App's log says why."
    exec sleep infinity ;;
esac
