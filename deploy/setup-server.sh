#!/bin/bash
set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

echo -e "${GREEN}╔════════════════════════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║         Cortex Server Setup Script                         ║${NC}"
echo -e "${GREEN}║         For Hetzner Cloud (Ubuntu 22.04)                   ║${NC}"
echo -e "${GREEN}╚════════════════════════════════════════════════════════════╝${NC}"
echo ""

if [ "$EUID" -ne 0 ]; then
    echo -e "${RED}Please run as root (use sudo)${NC}"
    exit 1
fi

echo -e "${YELLOW}Please provide the following information:${NC}"
echo ""

read -p "Domain name for Cortex API (e.g., api.example.com): " DOMAIN
read -p "Email for SSL certificates: " ACME_EMAIL
read -p "GitHub repository for Cortex (e.g., enntity/cortex): " GITHUB_REPOSITORY_CORTEX

echo ""
echo -e "${YELLOW}API Keys (press Enter to skip any):${NC}"
read -p "OpenAI API Key: " OPENAI_API_KEY
read -p "Anthropic API Key: " ANTHROPIC_API_KEY
read -p "XAI (Grok) API Key: " XAI_API_KEY
read -p "GCP Service Account Email (for Gemini/Vertex): " GCP_SERVICE_ACCOUNT_EMAIL
read -p "GCP Project ID: " GCP_PROJECT_ID

echo ""
echo -e "${YELLOW}Storage Configuration:${NC}"
read -p "Azure Storage Connection String (optional): " AZURE_STORAGE_CONNECTION_STRING
read -p "Azure Storage Container Name (default: cortex-files): " AZURE_STORAGE_CONTAINER_NAME
AZURE_STORAGE_CONTAINER_NAME=${AZURE_STORAGE_CONTAINER_NAME:-cortex-files}
read -p "GCS Bucket Name (optional): " GCS_BUCKET_NAME

echo ""
echo -e "${YELLOW}Security:${NC}"
read -p "Cortex API Keys (comma-separated, for client auth, optional): " CORTEX_API_KEYS

# Generate Redis password
REDIS_PASSWORD=$(openssl rand -base64 24 | tr -d '=+/')
echo -e "${GREEN}Generated Redis password${NC}"

# Generate Traefik dashboard credentials
read -p "Traefik dashboard username (default: admin): " TRAEFIK_USER
TRAEFIK_USER=${TRAEFIK_USER:-admin}
TRAEFIK_PASSWORD=$(openssl rand -base64 12 | tr -d '=+/')
TRAEFIK_DASHBOARD_AUTH=$(htpasswd -nb "$TRAEFIK_USER" "$TRAEFIK_PASSWORD" | sed 's/\$/\$\$/g')

echo ""
echo -e "${GREEN}Step 1: Updating system...${NC}"
apt-get update && apt-get upgrade -y

echo -e "${GREEN}Step 2: Installing Docker...${NC}"
if ! command -v docker &> /dev/null; then
    curl -fsSL https://get.docker.com | sh
    systemctl enable docker
    systemctl start docker
fi

echo -e "${GREEN}Step 3: Installing tools...${NC}"
apt-get install -y apache2-utils curl git ufw

echo -e "${GREEN}Step 4: Configuring firewall...${NC}"
ufw allow 22/tcp
ufw allow 80/tcp
ufw allow 443/tcp
# Allow Redis from private network only
ufw allow from 10.0.0.0/24 to any port 6379
ufw --force enable

echo -e "${GREEN}Step 5: Creating application directory...${NC}"
mkdir -p /opt/cortex
cd /opt/cortex

echo -e "${GREEN}Step 6: Creating environment file...${NC}"
cat > .env << EOF
# Domain Configuration
DOMAIN=${DOMAIN}
ACME_EMAIL=${ACME_EMAIL}

# GitHub Container Registry
GITHUB_REPOSITORY_CORTEX=${GITHUB_REPOSITORY_CORTEX}
IMAGE_TAG=latest

# Redis (shared with Concierge)
REDIS_PASSWORD=${REDIS_PASSWORD}

# API Keys
OPENAI_API_KEY=${OPENAI_API_KEY}
ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY}
XAI_API_KEY=${XAI_API_KEY}
GCP_SERVICE_ACCOUNT_EMAIL=${GCP_SERVICE_ACCOUNT_EMAIL}
GCP_PROJECT_ID=${GCP_PROJECT_ID}

# Storage
AZURE_STORAGE_CONNECTION_STRING=${AZURE_STORAGE_CONNECTION_STRING}
AZURE_STORAGE_CONTAINER_NAME=${AZURE_STORAGE_CONTAINER_NAME}
GCS_BUCKET_NAME=${GCS_BUCKET_NAME}

# Security
CORTEX_API_KEYS=${CORTEX_API_KEYS}

# Traefik Dashboard
TRAEFIK_DASHBOARD_AUTH=${TRAEFIK_DASHBOARD_AUTH}
EOF

chmod 600 .env

echo ""
echo -e "${GREEN}╔════════════════════════════════════════════════════════════╗${NC}"
echo -e "${GREEN}║                    Setup Complete!                         ║${NC}"
echo -e "${GREEN}╚════════════════════════════════════════════════════════════╝${NC}"
echo ""
echo -e "${YELLOW}IMPORTANT - Save this Redis password for Concierge server:${NC}"
echo -e "${RED}REDIS_PASSWORD=${REDIS_PASSWORD}${NC}"
echo ""
echo -e "${YELLOW}DNS Configuration:${NC}"
echo "   ${DOMAIN} → $(curl -s ifconfig.me)"
echo ""
echo -e "${YELLOW}GitHub Secrets for Cortex repo:${NC}"
echo "   DEPLOY_HOST: $(curl -s ifconfig.me)"
echo "   DEPLOY_USER: root"
echo "   DEPLOY_SSH_KEY: (your private SSH key)"
echo ""
echo -e "${YELLOW}Traefik Dashboard:${NC}"
echo "   URL: https://traefik.${DOMAIN}"
echo "   Username: ${TRAEFIK_USER}"
echo "   Password: ${TRAEFIK_PASSWORD}"
echo ""
echo "Environment file saved to: /opt/cortex/.env"
echo ""

