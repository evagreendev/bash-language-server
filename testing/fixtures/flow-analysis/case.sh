#!/bin/bash
# Test case statement evaluation

ANIMAL="cat"

case "$ANIMAL" in
  dog)
    SOUND="woof"
    ;;
  cat)
    SOUND="meow"
    ;;
  *)
    SOUND="unknown"
    ;;
esac

# Unknown value — all branches analyzed
case "$UNKNOWN_VAR" in
  a)
    UK_SOUND="a-sound"
    ;;
  b)
    UK_SOUND="b-sound"
    ;;
  *)
    UK_SOUND="default-sound"
    ;;
esac

# Glob pattern matching using wildcard
EXT="file.txt"
case "$EXT" in
  *.tar.gz)
    TYPE="tarball"
    ;;
  *.txt)
    TYPE="text"
    ;;
  *)
    TYPE="other"
    ;;
esac
