# Use official Azure Functions Python base image
FROM mcr.microsoft.com/azure-functions/python:4-python3.11

# Install LibreOffice + UNO Python bindings for fast conversions
RUN apt-get update && \
    apt-get install -y \
    libreoffice \
    libreoffice-writer \
    libreoffice-calc \
    libreoffice-impress \
    python3-uno \
    fonts-liberation \
    fonts-dejavu \
    fonts-liberation2 \
    fonts-noto \
    fonts-noto-cjk \
    fonts-noto-color-emoji \
    curl \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

# Set LibreOffice to use headless mode by default
ENV SAL_USE_VCLPLUGIN=svp

# Set the working directory
ENV AzureWebJobsScriptRoot=/home/site/wwwroot \
    AzureFunctionsJobHost__Logging__Console__IsEnabled=true \
    FUNCTIONS_WORKER_RUNTIME=python

# Copy requirements first for better layer caching
WORKDIR /home/site/wwwroot
COPY requirements.txt .

# Install Python dependencies
RUN pip install --no-cache-dir --upgrade pip && \
    pip install --no-cache-dir -r requirements.txt

# Copy function app files
COPY . .

# Make UNO startup script executable
RUN chmod +x start-unoserver.sh

# Expose port for standalone server mode
EXPOSE 8080

# Environment for unoserver
ENV UNOSERVER_PORT=2002 \
    UNO_PROFILE_DIR=/tmp/uno-profile

# Start unoserver daemon and then the app
CMD ["./start-unoserver.sh"]
