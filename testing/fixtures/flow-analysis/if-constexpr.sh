#!/bin/bash
# Test constexpr if evaluation

ENABLED=true
DISABLED=false

# Constant truthy — then branch taken
if [[ "$ENABLED" == "true" ]]; then
  BRANCH_RESULT="enabled-branch"
else
  BRANCH_RESULT="disabled-branch"
fi

# Constant falsy — else branch taken
if [[ "$DISABLED" == "true" ]]; then
  BRANCH_RESULT_2="should-not-happen"
else
  BRANCH_RESULT_2="correct-branch"
fi

# Numeric comparison [[ $X -eq N ]]
VALUE=5
if [[ $VALUE -eq 5 ]]; then
  NUM_BRANCH="equals-five"
else
  NUM_BRANCH="not-five"
fi

# Nested if
if [[ "$ENABLED" == "true" ]]; then
  if [[ $VALUE -gt 3 ]]; then
    NESTED="deep-branch"
  fi
fi

# elif chain
SCORE=85
if [[ $SCORE -lt 50 ]]; then
  GRADE="F"
elif [[ $SCORE -lt 70 ]]; then
  GRADE="C"
elif [[ $SCORE -lt 90 ]]; then
  GRADE="B"
else
  GRADE="A"
fi

# Variable expansion as command name — resolved to "false"
MY_FALSE=false
if "$MY_FALSE"
then
  CMD_VAR_THEN="should-not-happen"
else
  CMD_VAR_ELSE="command-is-false"
fi

# Variable expansion as command name — resolved to "true"
MY_TRUE=true
if "$MY_TRUE"
then
  CMD_TRUE_THEN="command-is-true"
else
  CMD_TRUE_ELSE="should-not-happen"
fi

# Variable expansion as command name without quotes — $VAR
if $MY_FALSE
then
  CMD_VAR2_THEN="should-not-happen"
else
  CMD_VAR2_ELSE="command-is-false-bare"
fi

# Dimming check: if "$VAR" where VAR=false should dim the then body
# (verified via ctx.dimmedRanges in tests)

# Composite conditions: list with &&
if true && true
then
  COMPOSITE_AND_TRUE="taken"
else
  COMPOSITE_AND_TRUE="skipped"
fi

if true && false
then
  COMPOSITE_AND_FALSE="should-not-happen"
else
  COMPOSITE_AND_FALSE="else-taken"
fi

# Composite conditions: list with ||
if false || true
then
  COMPOSITE_OR_TRUE="taken-short-circuit"
else
  COMPOSITE_OR_TRUE="skipped"
fi

if false || false
then
  COMPOSITE_OR_FALSE="should-not-happen"
else
  COMPOSITE_OR_FALSE="else-taken"
fi

# Mixed test_command && command
STATUS=1
if [[ $STATUS -eq 1 ]] && true
then
  COMPOSITE_MIXED="taken"
else
  COMPOSITE_MIXED="skipped"
fi

# Arithmetic expression as sole condition (( expr ))
if (( 5 == 5 ))
then
  ARITH_TRUE="taken"
else
  ARITH_TRUE="skipped"
fi

if (( 5 == 3 ))
then
  ARITH_FALSE="should-not-happen"
else
  ARITH_FALSE="else-taken"
fi

# Arithmetic with variable substitution in condition
X=10
if (( X > 5 ))
then
  ARITH_VAR_TRUE="taken"
else
  ARITH_VAR_TRUE="skipped"
fi

if (( X == 0 ))
then
  ARITH_VAR_FALSE="should-not-happen"
else
  ARITH_VAR_FALSE="else-taken"
fi

# Composite: test_command || arithmetic
if [[ 1 -eq 2 ]] || (( 10 == 10 ))
then
  COMPOSITE_MIXED2="taken-short-circuit"
else
  COMPOSITE_MIXED2="skipped"
fi

# Composite with variable command: true && "$VAR"
if true && "$MY_TRUE"
then
  COMPOSITE_VAR_CMD="taken"
else
  COMPOSITE_VAR_CMD="skipped"
fi
