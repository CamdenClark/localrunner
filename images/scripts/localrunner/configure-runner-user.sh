#!/bin/bash -e
################################################################################
##  File:  configure-runner-user.sh
##  Desc:  Create the runner user for GitHub Actions (localrunner-specific)
################################################################################

# Install sudo if not present
apt-get update && apt-get install -y sudo

# Create runner user with passwordless sudo
id runner &>/dev/null || useradd -m -s /bin/bash runner
mkdir -p /etc/sudoers.d
echo "runner ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers.d/runner
chmod 0440 /etc/sudoers.d/runner
