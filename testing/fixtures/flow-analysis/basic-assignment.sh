#!/bin/bash
# Test basic scalar assignments

NAME="hello"
VERSION=42
EMPTY=""
ZERO=0

# Reassignment
NAME="world"

# Concatenation in assignment
GREETING="Hello, ${NAME}!"

# Command substitution (can't resolve statically)
NOW=$(date)

# : "${VAR:=default}" pattern
: "${CONFIG_FILE:=/etc/myapp.conf}"

# += append
PATH="/usr/bin"
PATH+=":/usr/local/bin"
