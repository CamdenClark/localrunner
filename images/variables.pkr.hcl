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
  default     = "localactions pre-built runner image"
  description = "Description for the output image"
}

variable "docker_repository" {
  type        = string
  default     = "localactions"
  description = "Docker repository name for tagging (e.g. ghcr.io/owner/repo)"
}

variable "docker_push" {
  type        = bool
  default     = false
  description = "Whether to push the image after tagging"
}

variable "docker_login_server" {
  type        = string
  default     = ""
  description = "Docker registry login server (e.g. ghcr.io)"
}

variable "docker_login_username" {
  type        = string
  default     = ""
  description = "Docker registry login username"
}

variable "docker_login_password" {
  type        = string
  default     = ""
  sensitive   = true
  description = "Docker registry login password/token"
}

variable "push_tool_dir" {
  type        = string
  default     = "../push-tool"
  description = "Path to the chunked push tool directory"
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
