# Use an official Python runtime as a parent image
FROM python:3.11-slim

# Set the working directory in the container
WORKDIR /app

# Install system dependencies that might be needed
RUN apt-get update && apt-get install -y \
    gcc \
    curl \
    && rm -rf /var/lib/apt/lists/*

# Install poetry
RUN pip install poetry

# Configure poetry: Don't create virtual env (we're already in container)
RUN poetry config virtualenvs.create false

# Copy project descriptor files first (for better Docker layer caching)
COPY pyproject.toml poetry.lock* ./

# Create the coding directory inside the container
RUN mkdir -p /app/coding

# Create a minimal README.md if it's needed for build context
RUN touch README.md

# Copy the application's code before installing dependencies
COPY . /app/src/cortex_autogen2

# Install dependencies (including the current project)
RUN poetry install --without dev --no-ansi --no-interaction

# Install Playwright browser binaries
RUN playwright install

# Ensure Python can import our source package
ENV PYTHONPATH="/app/src:/app/src/cortex_autogen2"

# The command to run the application
CMD ["python", "-m", "cortex_autogen2.main"] 