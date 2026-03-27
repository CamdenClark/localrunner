/**
 * Detect the runner OS in GitHub Actions format.
 * Returns "macOS", "Linux", or "Windows".
 */
export function detectOs(): string {
  switch (process.platform) {
    case "darwin":
      return "macOS";
    case "linux":
      return "Linux";
    case "win32":
      return "Windows";
    default:
      return "Linux";
  }
}

/**
 * Detect the runner architecture in GitHub Actions format.
 * Returns "X64", "ARM64", "ARM", or "X86".
 */
export function detectArch(): string {
  switch (process.arch) {
    case "x64":
      return "X64";
    case "arm64":
      return "ARM64";
    case "arm":
      return "ARM";
    case "ia32":
      return "X86";
    default:
      return "X64";
  }
}
