#!/bin/bash
# Test arithmetic expansion

X=10
Y=3

SUM=$((X + Y))
DIFF=$((X - Y))
PROD=$((X * Y))
DIV=$((X / Y))
MOD=$((X % Y))

# Complex expression
COMPLEX=$(( (X + Y) * 2 - 1 ))

# With variable substitution
Z=$((SUM + DIFF))
