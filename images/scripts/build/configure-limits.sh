#!/bin/bash -e
################################################################################
##  File:  configure-limits.sh
##  Desc:  Configure limits (adapted for Docker - no systemd/pam)
##  From:  actions/runner-images (MIT License)
################################################################################

# Raise Number of File Descriptors
echo '* soft nofile 65536' >> /etc/security/limits.conf
echo '* hard nofile 65536' >> /etc/security/limits.conf

# Double stack size from default 8192KB
echo '* soft stack 16384' >> /etc/security/limits.conf
echo '* hard stack 16384' >> /etc/security/limits.conf
