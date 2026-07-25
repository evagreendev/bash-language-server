#!/bin/bash
# Fixture for testing path completions

# Simple path
ls /usr/

# Path with $HOME expansion in concatenation
bu_env_append_path "$HOME"/

# Path with partial directory
ls "$HOME"/.local/

# Regular path without variable
ls /etc/ssh/
