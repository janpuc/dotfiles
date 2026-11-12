#!/bin/sh
# bl, Alibaba Model Studio's CLI (npm:bailian-cli), in mise's global tools: pi-usage asks it for the
# Token Plan's monthly credit gauge, which no API gives the plan key. Sign in once by hand after a
# fresh install, with the key from op://Kubernetes/alibaba/ALIBABA_API_KEY:
#   bl auth login --config token-plan --api-key <key> --base-url https://token-plan.ap-southeast-1.maas.aliyuncs.com
#   bl auth login --console --config token-plan --console-site international
set -eu
/opt/homebrew/bin/mise use -g npm:bailian-cli@2.9.0
