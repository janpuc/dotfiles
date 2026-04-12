set -g fish_greeting

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
