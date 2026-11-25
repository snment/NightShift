# Starts the NightShift server the way it is meant to run: OMB_LOOPBACK_TRUST=service.
#
# Security invariant: every bot's shell reaches this server from this computer, just like your own terminal. Under
# service trust a command on this computer without a session may only use the service routes, take a bot's own
# review-loop step (--as-bot), or decline a card. It cannot pair itself, change settings, or approve a MEMORY.md change
# or a diff. You approve in the signed-in app or browser; the CLI uses a token file (docs/nightshift-routines-memory.md,
# "Running NightShift").
#
#   pwsh nightshift/start.ps1                                  # 127.0.0.1:8799, data in ~/.openmausbot
#   pwsh nightshift/start.ps1 --port 8799 --data-dir D:\nightshift-data
#
# Any argument is passed on to `openmausbot serve`. Run it in a terminal: the first sign-in code is printed there.
$ErrorActionPreference = 'Stop'
$env:OMB_LOOPBACK_TRUST = 'service'
$cli = Join-Path $PSScriptRoot '..\server\openmausbot.ts'
& node --experimental-strip-types $cli serve @args
exit $LASTEXITCODE
