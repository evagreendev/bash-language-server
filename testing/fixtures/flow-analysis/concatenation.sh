#!/bin/bash
# Test string concatenation

PREFIX="Hello"
SUFFIX="World"

# Concatenation with literal and variable
FULL="${PREFIX}, ${SUFFIX}!"

# Multiple concatenations
LONG="${PREFIX}_${SUFFIX}_end"
