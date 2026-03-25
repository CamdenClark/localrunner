#!/bin/bash -e
################################################################################
##  File:  configure-environment.sh
##  Desc:  Configure system and environment (adapted for Docker - no sysctl)
##  From:  actions/runner-images (MIT License)
################################################################################

source $HELPER_SCRIPTS/etc-environment.sh

# Set ImageVersion and ImageOS env variables
set_etc_environment_variable "ImageVersion" "${IMAGE_VERSION}"
set_etc_environment_variable "ImageOS" "${IMAGE_OS}"

# Set the ACCEPT_EULA variable to Y value
set_etc_environment_variable "ACCEPT_EULA" "Y"

# Create config directory in skel for new users
mkdir -p /etc/skel/.config/configstore
set_etc_environment_variable "XDG_CONFIG_HOME" '$HOME/.config'

# Add localhost alias to ::1 IPv6
sed -i 's/::1 ip6-localhost ip6-loopback/::1     localhost ip6-localhost ip6-loopback/g' /etc/hosts || true

# Prepare directory and env variable for toolcache
AGENT_TOOLSDIRECTORY=/opt/hostedtoolcache
mkdir -p $AGENT_TOOLSDIRECTORY
set_etc_environment_variable "AGENT_TOOLSDIRECTORY" "${AGENT_TOOLSDIRECTORY}"
set_etc_environment_variable "RUNNER_TOOL_CACHE" "${AGENT_TOOLSDIRECTORY}"
chmod -R 777 $AGENT_TOOLSDIRECTORY
