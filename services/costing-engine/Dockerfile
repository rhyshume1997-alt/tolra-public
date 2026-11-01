FROM python:3.11-slim

WORKDIR /app

# Install dependencies
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Run as an unprivileged user
RUN useradd --system --uid 10001 --no-create-home app

# Copy application
COPY app ./app
COPY startup.sh ./startup.sh

USER app

# Expose port
EXPOSE 8000

# Migrate/create tables, optionally seed, then serve
CMD ["sh", "/app/startup.sh"]
