#!/bin/bash
# Test parameter expansion patterns

# ${var:-default} — use default if unset or empty
DEFAULT_A="${UNSET_VAR:-fallback}"

# Set a variable, then test ${var:-default} with it
SET_VAR="original"
DEFAULT_B="${SET_VAR:-fallback}"

# ${var:=assign} — assign default if unset or empty
: "${ASSIGNED_VAR:=assigned_value}"

# ${var:+alternate} — use alternate if set
EXPANSION_C="${SET_VAR:+has_value}"

# ${var:+alternate} with unset var
EXPANSION_D="${UNSET_VAR:+should_be_empty}"
