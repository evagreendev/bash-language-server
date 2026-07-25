#!/bin/bash
# Test declaration command analysis

# local
function myfunc() {
  local LOCAL_VAR="local-scope"
  LOCAL_ONLY="$LOCAL_VAR"
}

# declare with assignment
declare DECLARE_VAR="declared"

# export with assignment
export EXPORT_VAR="exported"

# readonly
readonly READONLY_VAR="constant"

# declare -a (indexed array)
declare -a INDEXED=(a b c)

# declare without value — marks as existing
declare EXISTS_VAR

# typeset
typeset TYPESET_VAR="typeset-value"
