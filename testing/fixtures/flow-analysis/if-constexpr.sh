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
