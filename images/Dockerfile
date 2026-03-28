ARG BASE_IMAGE=ubuntu:24.04
FROM ${BASE_IMAGE}

ENV DEBIAN_FRONTEND=noninteractive

# Create /imagegeneration structure and copy scripts
RUN mkdir -p /imagegeneration && chmod 777 /imagegeneration
COPY scripts/helpers/ /imagegeneration/helpers/
COPY scripts/build/ /imagegeneration/installers/
COPY scripts/localactions/ /tmp/localactions/

ARG TOOLSET_FILE=toolsets/toolset-2404.json
COPY ${TOOLSET_FILE} /imagegeneration/installers/toolset.json

ENV HELPER_SCRIPTS=/imagegeneration/helpers \
    INSTALLER_SCRIPT_FOLDER=/imagegeneration/installers

###########################################################################
# Layer 1: Runner user + APT config + limits + environment
###########################################################################
ARG IMAGE_VERSION=dev
ARG IMAGE_OS=ubuntu24
RUN bash /tmp/localactions/configure-runner-user.sh && \
    bash /imagegeneration/installers/configure-apt-mock.sh && \
    HELPER_SCRIPTS=/imagegeneration/helpers \
    bash /imagegeneration/installers/configure-apt.sh && \
    bash /imagegeneration/installers/configure-limits.sh && \
    IMAGE_VERSION=${IMAGE_VERSION} IMAGE_OS=${IMAGE_OS} \
    HELPER_SCRIPTS=/imagegeneration/helpers \
    bash /imagegeneration/installers/configure-environment.sh

###########################################################################
# Layer 2: Vital + common APT packages
###########################################################################
RUN bash /imagegeneration/installers/install-apt-vital.sh && \
    bash /imagegeneration/installers/install-apt-common.sh && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

###########################################################################
# Layer 3: Git + Git LFS + GitHub CLI
###########################################################################
RUN bash /imagegeneration/installers/install-git.sh && \
    bash /imagegeneration/installers/install-git-lfs.sh && \
    bash /imagegeneration/installers/install-github-cli.sh && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

###########################################################################
# Layer 4: Node.js (nvm + node + global modules)
###########################################################################
RUN bash /imagegeneration/installers/install-nvm.sh && \
    bash /imagegeneration/installers/install-nodejs.sh

###########################################################################
# Layer 5: dpkg config + yq + Python + pipx + zstd
###########################################################################
RUN bash /imagegeneration/installers/configure-dpkg.sh && \
    bash /imagegeneration/installers/install-yq.sh && \
    bash /imagegeneration/installers/install-python.sh && \
    bash /imagegeneration/installers/install-pipx-packages.sh && \
    bash /imagegeneration/installers/install-zstd.sh && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

###########################################################################
# Layer 6: Docker CLI
###########################################################################
RUN bash /imagegeneration/installers/install-docker.sh && \
    apt-get clean && rm -rf /var/lib/apt/lists/*

###########################################################################
# Layer 7: GitHub Actions runner agent
###########################################################################
ARG RUNNER_VERSION=""
RUN RUNNER_VERSION=${RUNNER_VERSION} bash /tmp/localactions/install-runner-agent.sh

###########################################################################
# Layer 8: Actions cache + final cleanup
###########################################################################
RUN bash /imagegeneration/installers/install-actions-cache.sh && \
    bash /imagegeneration/installers/cleanup.sh && \
    rm -rf /tmp/localactions

USER runner
WORKDIR /home/runner
