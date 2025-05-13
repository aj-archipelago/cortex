# Use an official Python runtime as a parent image suitable for Azure Functions
FROM mcr.microsoft.com/azure-functions/python:4-python3.11

# Set environment variables for Azure Functions runtime
ENV AzureWebJobsScriptRoot=/home/site/wwwroot
ENV AzureFunctionsJobHost__Logging__Console__IsEnabled=true
# This might still be useful for Azure deployments, can be kept or removed based on specific SSL/TLS needs for accessing other Azure resources.
ENV WEBSITES_INCLUDE_CLOUD_CERTS=true

# Install Playwright dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    # Common fonts for rendering (can be useful even for headless)
    fonts-liberation \
    fonts-noto \
    fontconfig \
    # Clean up APT caches
    && rm -rf /var/lib/apt/lists/*

# Copy requirements file first to leverage Docker cache
COPY requirements.txt /tmp/
WORKDIR /tmp

# Install Python dependencies (including playwright)
RUN pip install --no-cache-dir -r requirements.txt

# Install Playwright browser(s) and their OS dependencies
# This installs Chromium by default along with its necessary OS packages.
# Add other browsers like firefox or webkit if needed: playwright install --with-deps firefox webkit
RUN playwright install --with-deps chromium

RUN playwright install-deps

# Copy the function app code to the final location
COPY . /home/site/wwwroot

# Set the working directory for the function app
WORKDIR /home/site/wwwroot

# Expose the default Azure Functions port
EXPOSE 80 