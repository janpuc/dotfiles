function pocket-kube-sync --description "Give Pi Pocket on aether its read-only kubeconfig"
    # The pi-pocket service account in home-ops (ai namespace, the view role) has a long-lived
    # token; this builds a kubeconfig from it with the home-ops admin kubeconfig and installs it
    # for the pocket user on aether (0600). Run again if the token is ever rotated.
    set -l admin $HOME/Development/home-ops/kubeconfig
    set -l secret (kubectl --kubeconfig $admin -n ai get secret pi-pocket-token -o json 2>/dev/null)
    or begin
        echo "pi-pocket-token not found in the ai namespace; is the home-ops change merged?" >&2
        return 1
    end
    set -l server (kubectl --kubeconfig $admin config view --minify -o jsonpath='{.clusters[0].cluster.server}')
    set -l tmp (mktemp)
    chmod 600 $tmp
    printf '%s' $secret | jq -r --arg server $server '
        "apiVersion: v1\nkind: Config\nclusters:\n- name: home-ops\n  cluster:\n    server: \($server)\n    certificate-authority-data: \(.data["ca.crt"])\nusers:\n- name: pi-pocket\n  user:\n    token: \(.data.token | @base64d)\ncontexts:\n- name: home-ops\n  context:\n    cluster: home-ops\n    user: pi-pocket\n    namespace: ai\ncurrent-context: home-ops"' >$tmp
    if ssh ubuntu@aether 'sudo install -d -o pocket -g pocket -m 700 /home/pocket/.kube && sudo install -m 600 -o pocket -g pocket /dev/stdin /home/pocket/.kube/config' <$tmp
        echo "Installed Pi Pocket's kubeconfig on aether."
    else
        echo "Could not install the kubeconfig on aether." >&2
    end
    rm -f $tmp
end
