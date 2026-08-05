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

### AI endpoints — not secrets, so plaintext here
set -gx MEMINI_BASE_URL "https://memini.janpuc.com"
set -gx LITELLM_BASE_URL "https://litellm.janpuc.com"

# Personal namespace, merged read-only into every recall on top of whatever
# project namespace is in force. This is why facts about me stay visible in the
# work tree too, which does not inherit homelab.
set -gx MEMINI_HOME "personal/jan"

# API keys are fetched once by `ai-sync` into a 0600 cache under XDG_STATE_HOME
# so no 1Password prompt fires on shell start or agent launch. Re-run after a
# key rotation.
if test -r "$XDG_STATE_HOME/ai/credentials.fish"
    source "$XDG_STATE_HOME/ai/credentials.fish"
end

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

## Granted
alias assume="source (brew --prefix)/bin/assume.fish"

## AI
alias claudex='CLAUDE_CODE_SUBAGENT_MODEL=gpt-5.6-sol \
CLAUDE_CODE_ALWAYS_ENABLE_EFFORT=1 \
CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY=3 \
ENABLE_TOOL_SEARCH=false \
claude --model gpt-5.6-sol'

# Claude Code against the self-hosted litellm instead of Anthropic. Uses the
# anthropic-format models, since Claude Code speaks /v1/messages. Plain `claude`
# is untouched and stays on claude-opus-5[1m].
#
# CLAUDE_CODE_SUBAGENT_MODEL must be set to the same litellm-routed model: the
# subagent loop reads its model from settings.json ("claude-opus-5[1m]"), which
# only exists on Anthropic's API and is rejected by litellm with a 400. The
# explicit override forces every Workflow/Agent subagent through litellm too.
alias claudel='ANTHROPIC_BASE_URL=$LITELLM_BASE_URL \
ANTHROPIC_AUTH_TOKEN=$LITELLM_API_KEY \
CLAUDE_CODE_SUBAGENT_MODEL=minimax/MiniMax-M3-anthropic \
claude --model minimax/MiniMax-M3-anthropic'

## Config

/opt/homebrew/bin/brew shellenv | source

source ~/.config/op/plugins.sh

source ~/.orbstack/shell/init2.fish 2>/dev/null || :

fish_config theme choose catppuccin-mocha

atuin init fish | source

starship init fish | source

zoxide init --cmd cd fish | source

enable_transience

# Autoloaded --on-variable handlers only register once the function has been
# loaded, so call it here to both register the hook and apply it to the
# directory this shell started in.
__memini_namespace_prefix

# Hermes Agent — ensure ~/.local/bin is on PATH
fish_add_path "$HOME/.local/bin"
