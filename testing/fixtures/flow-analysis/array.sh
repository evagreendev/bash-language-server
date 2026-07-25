#!/bin/bash
# Test array assignments

# Simple array
FRUITS=(apple banana cherry)

# Array with quoted elements
FILES=("file one.txt" "file two.txt")

# Append to array
FRUITS+=(date)

# Indexed assignment
FRUITS[4]=elderberry

# Array from expansion
MORE=(kiwi lemon)
ALL=("${FRUITS[@]}" "${MORE[@]}")
