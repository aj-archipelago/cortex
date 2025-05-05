# Use an official Python runtime as a parent image suitable for Azure Functions
FROM mcr.microsoft.com/azure-functions/python:4-python3.9

# Set environment variables for Azure Functions runtime
ENV AzureWebJobsScriptRoot=/home/site/wwwroot
ENV AzureFunctionsJobHost__Logging__Console__IsEnabled=true

# Install OS dependencies needed by Playwright browsers (Debian-based)
# This list is based on Playwright documentation and common needs
RUN apt-get update && apt-get install -y --no-install-recommends \
    libnss3 \
    libnspr4 \
    libdbus-glib-1-2 \
    libatk1.0-0 \
    libatk-bridge2.0-0 \
    libcups2 \
    libdrm2 \
    libexpat1 \
    libgbm1 \
    libpango-1.0-0 \
    libx11-6 \
    libxcb1 \
    libxcomposite1 \
    libxdamage1 \
    libxext6 \
    libxfixes3 \
    libxrandr2 \
    libxrender1 \
    libxtst6 \
    lsb-release \
    wget \
    xvfb \
    # Clean up apt cache
    && rm -rf /var/lib/apt/lists/*

# Copy requirements file first to leverage Docker cache
COPY requirements.txt /tmp/
WORKDIR /tmp

# Install Python dependencies
RUN pip install --no-cache-dir -r requirements.txt

# Install Playwright browsers and their dependencies within the container
# Using --with-deps helps install system dependencies needed by the browsers
# Installing only chromium as it's specified in the code
RUN playwright install --with-deps chromium

# Copy the function app code to the final location
COPY . /home/site/wwwroot

# Set the working directory for the function app
WORKDIR /home/site/wwwroot 