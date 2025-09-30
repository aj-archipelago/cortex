# ────────────────────────────────────────────────────────────────
# BASE IMAGE  (Python 3.11, Azure Functions Runtime v4)
# ────────────────────────────────────────────────────────────────
FROM mcr.microsoft.com/azure-functions/python:4-python3.11

# ------------------------------------------------------------------------------
# 1. Azure Functions environment variables
# ------------------------------------------------------------------------------
ENV AzureWebJobsScriptRoot=/home/site/wwwroot \
    AzureFunctionsJobHost__Logging__Console__IsEnabled=true \
    WEBSITES_INCLUDE_CLOUD_CERTS=true \
    FUNCTIONS_WORKER_RUNTIME=python \
    AzureWebJobsFeatureFlags=EnableWorkerIndexing

# ------------------------------------------------------------------------------
# 2. System-level packages required by many of the new Python deps
# ------------------------------------------------------------------------------

RUN apt-get update && DEBIAN_FRONTEND=noninteractive \
    apt-get install -y --no-install-recommends \
        # ─ Fonts & Playwright basics
        fonts-liberation fonts-noto fontconfig \
        # ─ Build chain for packages that still compile C/C++
        build-essential gcc g++ make \
        # ─ libmagic for `python-magic`
        libmagic1 libmagic-dev \
        # ─ FFmpeg for `moviepy`, `imageio[ffmpeg]`, `pydub`
        ffmpeg \
        # ─ HEIF/HEIC support for `pyheif`
        libde265-dev libheif-dev \
        # ─ Audio support for `librosa` / `soundfile`
        libsndfile1 \
        # ─ Computer-vision helpers sometimes needed by OpenCV
        libsm6 libxext6 libglib2.0-0 \
        # ─ HDF5 stack for `h5py`
        libhdf5-serial-dev hdf5-tools \
        # ─ Cairo / Pango / GDK-PixBuf for SVG->PNG rendering (CairoSVG optional deps)
        libcairo2 libcairo2-dev \
        libpango-1.0-0 libpangoft2-1.0-0 libpangocairo-1.0-0 \
        libgdk-pixbuf-2.0-0 libgdk-pixbuf2.0-bin \
        # ─ GDAL for GIS formats (and Python bindings)
        gdal-bin libgdal-dev python3-gdal \
        # ─ 7-Zip & RAR extractors (for patool / rarfile fall-back)
        unrar-free \
        # ─ Clean-up
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

# Allow GDAL Python wheels to find headers
ENV CPLUS_INCLUDE_PATH=/usr/include/gdal
ENV C_INCLUDE_PATH=/usr/include/gdal

# ------------------------------------------------------------------------------
# 3. Python dependencies
#    – We copy only the files that affect dependency resolution first
#      (leverages Docker layer cache).
# ------------------------------------------------------------------------------
WORKDIR /tmp

# Copy requirements for pip-based install
COPY requirements.txt .

# Use a pip version compatible with packages that have legacy metadata (e.g., textract 1.6.5)
RUN python -m pip install --upgrade 'pip<24.1' setuptools wheel

# Install all Python packages — no cache -> smaller image
RUN pip install --no-cache-dir -r requirements.txt

# ------------------------------------------------------------------------------
# 4. Playwright browsers (chromium only to keep image light)
# ------------------------------------------------------------------------------
RUN playwright install --with-deps chromium

# ------------------------------------------------------------------------------
# 5. Copy your Azure Functions source code
# ------------------------------------------------------------------------------
WORKDIR /home/site/wwwroot
COPY . .

# Ports: Azure Functions host inside the container listens on 80 by default.
# (You normally don’t need EXPOSE for Azure App Service, but uncomment if you
# run the image locally.)
# EXPOSE 80

# ------------------------------------------------------------------------------
# 6. The base image already contains the correct ENTRYPOINT / CMD
#    to launch the Functions host, so nothing to add here.
# ------------------------------------------------------------------------------
