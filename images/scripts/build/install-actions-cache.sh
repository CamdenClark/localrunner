#!/bin/bash -e
################################################################################
##  File:  install-actions-cache.sh
##  Desc:  Set up the actions archive cache directory. The runner checks
##         ACTIONS_RUNNER_ACTION_ARCHIVE_CACHE before fetching actions from
##         GitHub. We create the directory but don't pre-populate it — actions
##         are downloaded on demand.
##  From:  actions/runner-images (MIT License)
################################################################################

source $HELPER_SCRIPTS/etc-environment.sh

CACHE_DIR="/opt/actionarchivecache"
mkdir -p "$CACHE_DIR"
chmod -R 777 "$CACHE_DIR"

# Set env var so the runner knows where to find cached actions
set_etc_environment_variable "ACTIONS_RUNNER_ACTION_ARCHIVE_CACHE" "$CACHE_DIR"
