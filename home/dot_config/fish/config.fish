set -g fish_greeting

## Envs

set -gx EDITOR nano
set -gx MANROFFOPT "-c"
set -gx MANPAGER "sh -c 'col -bx | bat -l man -p'"
set -gx PAGER bat
set -gx SSH_AUTH_SOCK "~/Library/Group Containers/2BUA8C4S2C.com.1password/t/agent.sock"
set -gx VISUAL nano

## Abbrs

abbr --add g git

## Aliases

### Kubernetes
alias k="kubectl"
alias kx="kubectx"
alias ku="kubectx -u"

### AWS
alias ax="awsx"
alias au="set -e AWS_PROFILE"
alias ao="assume -ar"

## Config

fish_config theme choose catppuccin-mocha

starship init fish | source

enable_transience
