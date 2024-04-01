# For more information, please refer to https://aka.ms/vscode-docker-python
#FROM python:3.10-slim
FROM nvidia/cuda:12.2.2-devel-ubuntu22.04

# Update system and install necessary packages, including python3.10
RUN apt-get update && apt-get install -y \
    ffmpeg \
    python3.10 \
    python3-pip \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/* \
    && ln -s /usr/bin/python3.10 /usr/bin/python

# # Update and install necessary packages.
# RUN apt-get update && apt-get install -y \
#     ffmpeg \
#     nvidia-cuda-toolkit \
#     && apt-get clean \
#     && rm -rf /var/lib/apt/lists/*

# Verify that the CUDA toolkit was installed correctly
RUN nvcc --version

# # Update system and install necessary packages
# RUN apt-get update && apt-get install -y \
#     ffmpeg \
#     && apt-get clean \
#     && rm -rf /var/lib/apt/lists/*


EXPOSE 8000

# ## following 3 lines are for installing ffmepg
# RUN apt-get -y update
# RUN apt-get -y upgrade
# RUN apt-get install -y ffmpeg

# # Install CUDA toolkit
# RUN apt-get install -y nvidia-cuda-toolkit

# Keeps Python from generating .pyc files in the container
ENV PYTHONDONTWRITEBYTECODE=1

# Turns off buffering for easier container logging
ENV PYTHONUNBUFFERED=1

# Install pip requirements
COPY requirements.txt .
RUN python -m pip install -r requirements.txt

WORKDIR /app
COPY ./models /app/models
COPY . /app

# Creates a non-root user with an explicit UID and adds permission to access the /app folder
# For more info, please refer to https://aka.ms/vscode-docker-python-configure-containers
RUN adduser -u 5678 --disabled-password --gecos "" appuser && chown -R appuser /app
USER appuser

# During debugging, this entry point will be overridden. For more information, please refer to https://aka.ms/vscode-docker-python-debug
# CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8000"]
CMD ["gunicorn", "--bind", "0.0.0.0:8000", "--timeout", "0", "-k", "uvicorn.workers.UvicornWorker", "app:app"]
