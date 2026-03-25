#!/bin/bash -e
################################################################################
##  File:  cleanup.sh
##  Desc:  Perform cleanup (adapted for Docker - no journalctl)
##  From:  actions/runner-images (MIT License)
################################################################################

# Clear apt cache
apt-get clean
rm -rf /tmp/*
rm -rf /root/.cache

# Delete rotated log files
find /var/log -type f -regex ".*\.gz$" -delete
find /var/log -type f -regex ".*\.[0-9]$" -delete

# Wipe log files
find /var/log/ -type f -exec cp /dev/null {} \;

# Remove apt mock wrappers
prefix=/usr/local/bin
for tool in apt apt-get apt-key; do
    rm -f $prefix/$tool
done

# Clean yarn and npm cache
if command -v yarn &>/dev/null; then
    yarn cache clean
fi
if command -v npm &>/dev/null; then
    npm cache clean --force
fi

# Set permissions
chmod -R 777 /usr/share
chmod -R 777 /opt
