variable "base_image" {
  type        = string
  description = "Base Docker image (e.g. ubuntu:24.04)"
}

variable "image_family" {
  type        = string
  description = "Image family name for the output image"
}

variable "image_description" {
  type        = string
  default     = "localrunner pre-built runner image"
  description = "Description for the output image"
}

variable "docker_repository" {
  type        = string
  default     = "localrunner"
  description = "Docker repository name for tagging"
}

variable "runner_version" {
  type        = string
  default     = ""
  description = "GitHub Actions runner version (empty = latest)"
}

# Matches the official runner-images variable names
variable "helper_script_folder" {
  type    = string
  default = "/imagegeneration/helpers"
}

variable "image_folder" {
  type    = string
  default = "/imagegeneration"
}

variable "installer_script_folder" {
  type    = string
  default = "/imagegeneration/installers"
}

variable "image_version" {
  type    = string
  default = "dev"
}

variable "image_os" {
  type    = string
  default = "ubuntu24"
}

variable "toolset_file" {
  type    = string
  default = "toolsets/toolset-2404.json"
}
