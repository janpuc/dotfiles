set -g fish_greeting

## Envs

### XDG
set -gx XDG_CONFIG_HOME "$HOME/.config"
set -gx XDG_CACHE_HOME "$HOME/.cache"
set -gx XDG_DATA_HOME "$HOME/.local/share"
set -gx XDG_STATE_HOME "$HOME/.local/state"

set -gx HOMEBREW_PREFIX "/opt/homebrew"
set -gx EDITOR nano
set -gx MANROFFOPT "-c"
set -gx MANPAGER "sh -c 'col -bx | bat -l man -p'"
set -gx PAGER bat
set -gx SSH_AUTH_SOCK "~/Library/Group Containers/2BUA8C4S2C.com.1password/t/agent.sock"
set -gx VISUAL nano
set -gx SAML2AWS_CONFIGFILE "~/.aws/saml2aws/config"

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

### Misc
alias cat="bat --paging=never"
alias less="bat"
alias ls="eza --group-directories-first --header --git --icons=auto"
alias reload='exec $SHELL -l'
alias tree="eza --tree"
alias unset="set -e"
alias unexport="set -e"

## Config

/opt/homebrew/bin/brew shellenv | source

source ~/.config/op/plugins.sh

fish_config theme choose catppuccin-mocha

atuin init fish | source

starship init fish | source

zoxide init --cmd cd fish | source

enable_transience
