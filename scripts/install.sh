#!/usr/bin/env bash
#
# install.sh — ServerBrowser installation script
#
# Installs all prerequisites:
#   - Node.js 18+
#   - Google Chrome (stable)
#   - Playwright 1.40+
#   - Project dependencies (npm install)
#
# Usage:
#   bash scripts/install.sh
#
# Env overrides:
#   NODE_VERSION       Node.js version to install (default: 20)
#   CHROME_REPO        Google Chrome apt repo (default: stable)
#   PLAYWRIGHT_VERSION Playwright version (default: latest)
#

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG="/tmp/serverbrowser-install-$(date +%Y%m%d-%H%M%S).log"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

# Logging
log() {
  local msg="[ServerBrowser] $1"
  echo -e "${msg}"
  echo -e "$(date '+%Y-%m-%d %H:%M:%S') ${msg}" >> "${LOG}"
}

log_info() { log "${BLUE}INFO${NC} $1"; }
log_ok() { log "${GREEN}OK${NC}   $1"; }
log_warn() { log "${YELLOW}WARN${NC} $1"; }
log_error() { log "${RED}ERROR${NC} $1"; }

# ASCII Art Banner
show_banner() {
  cat << 'BANNER'
  ______ _            _____ _               _    _      _     _                _
 |  ____(_)          / ____| |             | |  | |    | |   | |              | |
 | |____ _ ___  ___ | |    | |__   ___  ___| | _| |_ __| | __| |___ _   _  ___| |__
 |  __| | / __|/ _ \| |    | '_ \ / _ \/ __| |/ / __/ _` |/ _` / __| | | |/ __| '_ \
 | |  | | \__ \  __/| |____| | | |  __| (__|   <| || (_| | (_| \__ \ |_| | (__| | | |
 |_|  |_|_|___/\___| \_____|_| |_|\___|\___|_|\_\\__\__,_|\__,_|___/\__,_|\___|_| |_|

   Stealth Headless Google Chrome (via Playwright)
   Persistent, real-Chrome, hard-to-detect browsing + web search toolkit
BANNER
}

# Check if running as root
check_root() {
  if [[ $EUID -ne 0 ]]; then
    log_warn "Not running as root. Some installations may require sudo."
    log_info "You may be prompted for your password during installation."
  fi
}

# Detect OS
detect_os() {
  if [[ -f /etc/os-release ]]; then
    . /etc/os-release
    OS=$ID
    OS_VERSION=$VERSION_ID
  elif [[ "$(uname)" == "Darwin" ]]; then
    OS="macos"
    OS_VERSION=$(sw_vers -productVersion)
  else
    OS="unknown"
    OS_VERSION="unknown"
  fi
  log_info "Detected OS: ${OS} ${OS_VERSION}"
}

# Check Node.js version
check_node() {
  if command -v node &>/dev/null; then
    NODE_VERSION=$(node -v | sed 's/v//' | cut -d. -f1)
    if [[ $NODE_VERSION -ge 18 ]]; then
      log_ok "Node.js $(node -v) is already installed"
      return 0
    else
      log_warn "Node.js $(node -v) is too old (need 18+)"
      return 1
    fi
  else
    log_warn "Node.js not found"
    return 1
  fi
}

# Install Node.js
install_node() {
  log_info "Installing Node.js 20 LTS..."
  
  if [[ "$OS" == "ubuntu" || "$OS" == "debian" ]]; then
    if ! command -v curl &>/dev/null; then
      log_info "Installing curl..."
      apt-get update -qq && apt-get install -y -qq curl
    fi
    
    log_info "Adding NodeSource repository..."
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
    
    log_info "Installing Node.js..."
    apt-get install -y -qq nodejs
    
    log_ok "Node.js installed: $(node -v)"
  elif [[ "$OS" == "macos" ]]; then
    if ! command -v brew &>/dev/null; then
      log_error "Homebrew not found. Please install from https://brew.sh/"
      exit 1
    fi
    brew install node@20
    log_ok "Node.js installed: $(node -v)"
  else
    log_error "Unsupported OS for automatic Node.js installation: $OS"
    log_info "Please install Node.js 18+ manually from https://nodejs.org/"
    exit 1
  fi
}

# Check Google Chrome
check_chrome() {
  if command -v google-chrome &>/dev/null || command -v google-chrome-stable &>/dev/null; then
    CHROME_VERSION=$(google-chrome --version 2>/dev/null || google-chrome-stable --version 2>/dev/null | grep -oP '\d+' | head -1)
    log_ok "Google Chrome ${CHROME_VERSION} is already installed"
    return 0
  else
    log_warn "Google Chrome not found"
    return 1
  fi
}

# Install Google Chrome
install_chrome() {
  log_info "Installing Google Chrome Stable..."
  
  if [[ "$OS" == "ubuntu" || "$OS" == "debian" ]]; then
    if ! command -v wget &>/dev/null; then
      log_info "Installing wget..."
      apt-get update -qq && apt-get install -y -qq wget gnupg
    fi
    
    log_info "Adding Google Chrome repository..."
    wget -q -O - https://dl.google.com/linux/linux_signing_key.pub | gpg --dearmor | tee /usr/share/keyrings/google-chrome-keyring.gpg > /dev/null
    
    echo "deb [arch=amd64 signed-by=/usr/share/keyrings/google-chrome-keyring.gpg] http://dl.google.com/linux/chrome/deb/ stable main" | tee /etc/apt/sources.list.d/google-chrome.list
    
    log_info "Installing Chrome..."
    apt-get update -qq
    apt-get install -y -qq google-chrome-stable
    
    log_ok "Google Chrome installed"
  elif [[ "$OS" == "macos" ]]; then
    if ! command -v brew &>/dev/null; then
      log_error "Homebrew not found. Please install from https://brew.sh/"
      exit 1
    fi
    brew install --cask google-chrome
    log_ok "Google Chrome installed"
  else
    log_error "Unsupported OS for automatic Chrome installation: $OS"
    log_info "Please install Google Chrome manually from https://www.google.com/chrome/"
    exit 1
  fi
}

# Check Playwright
check_playwright() {
  if command -v playwright &>/dev/null; then
    PW_VERSION=$(playwright --version 2>/dev/null || echo "unknown")
    log_ok "Playwright ${PW_VERSION} is already installed"
    return 0
  else
    log_warn "Playwright not found"
    return 1
  fi
}

# Install Playwright
install_playwright() {
  log_info "Installing Playwright..."
  
  if [[ "$OS" == "ubuntu" || "$OS" == "debian" ]]; then
    apt-get install -y -qq libnss3 libnspr4 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 libxkbcommon0 libxcomposite1 libxdamage1 libxrandr2 libgbm1 libpango-1.0-0 libcairo2 libasound2 libxshmfence1 2>/dev/null || true
  fi
  
  npm install -g playwright
  
  log_ok "Playwright installed globally"
  
  log_info "Installing Playwright browsers..."
  playwright install chromium
  
  log_ok "Playwright browsers installed"
}

# Install project dependencies
install_deps() {
  log_info "Installing project dependencies..."
  
  cd "$ROOT"
  
  if [[ ! -f package.json ]]; then
    log_error "package.json not found in $ROOT"
    exit 1
  fi
  
  npm install
  
  log_ok "Project dependencies installed"
}

# Verify installation
verify_installation() {
  log_info "Verifying installation..."
  
  local errors=0
  
  if ! check_node; then
    log_error "Node.js verification failed"
    ((errors++))
  fi
  
  if ! check_chrome; then
    log_error "Google Chrome verification failed"
    ((errors++))
  fi
  
  if ! check_playwright; then
    log_error "Playwright verification failed"
    ((errors++))
  fi
  
  if [[ $errors -eq 0 ]]; then
    log_ok "All prerequisites verified successfully!"
    return 0
  else
    log_error "Verification failed with $errors error(s)"
    return 1
  fi
}

# Main installation flow
main() {
  show_banner
  
  echo
  log_info "This script will install the following prerequisites:"
  echo "  - Node.js 18+ (LTS)"
  echo "  - Google Chrome Stable"
  echo "  - Playwright 1.40+"
  echo "  - Project dependencies"
  echo
  
  read -p "Do you want to continue? (y/N) " -n 1 -r
  echo
  if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    log_info "Installation cancelled by user"
    exit 0
  fi
  
  echo
  log_info "Starting ServerBrowser installation..."
  log_info "Log file: ${LOG}"
  echo
  
  # Detect OS first
  detect_os
  check_root
  echo
  
  # Install prerequisites
  if ! check_node; then
    install_node
    echo
  fi
  
  if ! check_chrome; then
    install_chrome
    echo
  fi
  
  if ! check_playwright; then
    install_playwright
    echo
  fi
  
  install_deps
  echo
  
  # Verify
  if verify_installation; then
    echo
    show_banner
    echo
    log_ok "ServerBrowser installation complete!"
    echo
    log_info "Next steps:"
    echo "  1. Test the installation:"
    echo "     node headless.js https://example.com"
    echo
    echo "  2. Try the VNC live browser:"
    echo "     npm run vnc"
    echo
    echo "  3. Read the documentation:"
    echo "     cat docs/LIVE-DRIVE.md"
    echo
    exit 0
  else
    echo
    log_error "Installation completed with errors. Please check the log:"
    log_error "  ${LOG}"
    exit 1
  fi
}

main "$@"
