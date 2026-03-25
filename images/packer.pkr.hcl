packer {
  required_plugins {
    docker = {
      version = ">= 1.1.0"
      source  = "github.com/hashicorp/docker"
    }
  }
}

locals {
  timestamp  = formatdate("YYYYMMDDhhmmss", timestamp())
  image_name = "${var.image_family}-${local.timestamp}"
}

source "docker" "runner" {
  image  = var.base_image
  commit = true
  changes = [
    "ENV DEBIAN_FRONTEND=noninteractive",
    "USER runner",
    "WORKDIR /home/runner",
  ]
  run_command = ["-d", "-i", "-t", "{{.Image}}", "/bin/bash"]
}

build {
  sources = ["source.docker.runner"]

  # Create /imagegeneration directory structure (matches official runner-images)
  provisioner "shell" {
    inline = ["mkdir ${var.image_folder}", "chmod 777 ${var.image_folder}"]
  }

  # Upload helpers to /imagegeneration/helpers/
  provisioner "file" {
    destination = "${var.helper_script_folder}"
    source      = "scripts/helpers"
  }

  # Upload installer scripts to /imagegeneration/installers/
  provisioner "file" {
    destination = "${var.installer_script_folder}"
    source      = "scripts/build"
  }

  # Upload toolset.json to /imagegeneration/installers/toolset.json
  provisioner "file" {
    destination = "${var.installer_script_folder}/toolset.json"
    source      = "${var.toolset_file}"
  }

  ###########################################################################
  # localrunner-specific: Create runner user
  ###########################################################################
  provisioner "shell" {
    script = "scripts/localrunner/configure-runner-user.sh"
  }

  ###########################################################################
  # APT configuration (matches official runner-images order)
  ###########################################################################
  provisioner "shell" {
    script = "scripts/build/configure-apt-mock.sh"
  }

  provisioner "shell" {
    environment_vars = ["HELPER_SCRIPTS=${var.helper_script_folder}", "DEBIAN_FRONTEND=noninteractive"]
    scripts          = ["scripts/build/configure-apt.sh"]
  }

  provisioner "shell" {
    script = "scripts/build/configure-limits.sh"
  }

  ###########################################################################
  # Environment configuration
  ###########################################################################
  provisioner "shell" {
    environment_vars = ["IMAGE_VERSION=${var.image_version}", "IMAGE_OS=${var.image_os}", "HELPER_SCRIPTS=${var.helper_script_folder}"]
    scripts          = ["scripts/build/configure-environment.sh"]
  }

  ###########################################################################
  # Vital packages
  ###########################################################################
  provisioner "shell" {
    environment_vars = ["DEBIAN_FRONTEND=noninteractive", "HELPER_SCRIPTS=${var.helper_script_folder}", "INSTALLER_SCRIPT_FOLDER=${var.installer_script_folder}"]
    scripts          = ["scripts/build/install-apt-vital.sh"]
  }

  ###########################################################################
  # Main installer scripts (matches official runner-images order, minus cut items)
  ###########################################################################
  provisioner "shell" {
    environment_vars = ["HELPER_SCRIPTS=${var.helper_script_folder}", "INSTALLER_SCRIPT_FOLDER=${var.installer_script_folder}", "DEBIAN_FRONTEND=noninteractive"]
    scripts = [
      "scripts/build/install-apt-common.sh",
      "scripts/build/install-cmake.sh",
      "scripts/build/install-git.sh",
      "scripts/build/install-git-lfs.sh",
      "scripts/build/install-github-cli.sh",
      "scripts/build/install-java-tools.sh",
      "scripts/build/install-nvm.sh",
      "scripts/build/install-nodejs.sh",
      "scripts/build/configure-dpkg.sh",
      "scripts/build/install-yq.sh",
      "scripts/build/install-python.sh",
      "scripts/build/install-pipx-packages.sh",
      "scripts/build/install-zstd.sh",
      "scripts/build/install-ninja.sh",
    ]
  }

  ###########################################################################
  # Docker CLI (no daemon in container - mount socket at runtime)
  ###########################################################################
  provisioner "shell" {
    environment_vars = ["HELPER_SCRIPTS=${var.helper_script_folder}", "INSTALLER_SCRIPT_FOLDER=${var.installer_script_folder}"]
    scripts          = ["scripts/build/install-docker.sh"]
  }

  ###########################################################################
  # localrunner-specific: Runner agent
  ###########################################################################
  provisioner "shell" {
    environment_vars = ["RUNNER_VERSION=${var.runner_version}"]
    script           = "scripts/localrunner/install-runner-agent.sh"
  }

  ###########################################################################
  # Pre-cache common GitHub Actions (~227 MB, saves download on every job)
  ###########################################################################
  provisioner "shell" {
    environment_vars = ["HELPER_SCRIPTS=${var.helper_script_folder}", "INSTALLER_SCRIPT_FOLDER=${var.installer_script_folder}"]
    scripts          = ["scripts/build/install-actions-cache.sh"]
  }

  ###########################################################################
  # Cleanup
  ###########################################################################
  provisioner "shell" {
    scripts = ["scripts/build/cleanup.sh"]
  }

  ###########################################################################
  # Tag and push the image
  ###########################################################################
  post-processors {
    post-processor "docker-tag" {
      repository = var.docker_repository
      tags       = [var.image_os, "${var.image_os}-${local.timestamp}"]
    }

    post-processor "docker-push" {
      login          = var.docker_push
      login_server   = var.docker_login_server
      login_username = var.docker_login_username
      login_password = var.docker_login_password
    }
  }
}
