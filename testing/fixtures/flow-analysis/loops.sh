#!/bin/bash
# Test loop analysis

# For loop over literal list
for fruit in apple banana cherry; do
  LAST_FRUIT="$fruit"
done

# For loop with variable
WORDS="one two three"
for word in $WORDS; do
  LAST_WORD="$word"
done

# While loop with known falsy condition
while false; do
  NEVER_REACHED="yes"
done

# While loop with known truthy condition
# NOTE: we only analyze one iteration for now
COUNT=0
while [[ $COUNT -lt 1 ]]; do
  COUNT=1
  IN_LOOP="executed"
done
